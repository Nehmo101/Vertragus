/**
 * LIVE handover probe — the assignment, typed into a REAL agent CLI.
 *
 * Everything else in this repository proves the handover against a fake pty or
 * against `scripts/paste-tui.mjs`. Both are honest about *bytes*, neither can
 * be honest about a real CLI: whether cursor-agent's composer keeps a
 * multi-KB paste in one piece, whether Claude Code's Enter lands, whether the
 * agent then actually did what the assignment said. That is what kept
 * breaking, so that is what this file measures — the production path start to
 * finish:
 *
 *   temp git repo → real MCP server → Workspace.startAgent
 *     → real worktree → real spawnAgent → real seedWithReadyHandshake
 *     → real CLI → report back (MCP `report_done` or a PTY sentinel line)
 *
 * The task is a self-verifying one: the agent must report a token it can only
 * produce by READING the assignment to its end (a word it has to reverse), so
 * an echo of the prompt in the scrollback can never be mistaken for success.
 *
 *   VERTRAGUS_LIVE=1 pnpm vitest run tests/live/handover.live.test.ts
 *   VERTRAGUS_LIVE=1 VERTRAGUS_LIVE_PROVIDERS=claude,cursor pnpm vitest run …
 *
 * Skipped without `VERTRAGUS_LIVE` — it costs real model tokens and needs the
 * CLIs installed and logged in.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startMcpServer, type McpServerHandle } from '@main/mcp/server'
import { providerPresets } from '@main/providers/presets'
import { Workspace } from '@main/workspace/Workspace'
import { FakeRegistry, FakeWindows } from '@main/workspace/testing'
import { buildTaskContract } from '@shared/prompts/contract'
import { BUILTIN_ROLE_TEMPLATES, WORKER_ROLE_ID } from '@shared/prompts/roles'
import { profileSchema } from '@shared/schema/profile'
import type { AgentEvent } from '@shared/schema/events'

const LIVE = process.env.VERTRAGUS_LIVE === '1'

/** Which presets to probe; default is the one CLI every dev here has. */
const PROVIDERS = (process.env.VERTRAGUS_LIVE_PROVIDERS ?? 'claude')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean)

/** How long a live agent gets to read its assignment and report back. */
const REPORT_TIMEOUT_MS = Number(process.env.VERTRAGUS_LIVE_TIMEOUT_MS ?? 180_000)

/** Where the full scrollback of each probe is written for post-mortems. */
const logDir = process.env.VERTRAGUS_LIVE_LOG_DIR ?? join(tmpdir(), 'vertragus-live-logs')

/**
 * The word the agent has to reverse. Its reversal appears nowhere in the
 * assignment, so finding it proves the CLI read and executed — not echoed.
 */
const SECRET = 'PALINDROM'
const EXPECTED = [...SECRET].reverse().join('')

function probeTask(reporting: 'mcp' | 'sentinel'): string {
  const body = [
    'This is a delivery probe, not development work. Do NOT read the repository,',
    'do NOT edit any file, do NOT run any command.',
    '',
    `Take the word ${SECRET}, reverse its letters, and report the result immediately`,
    `as: HANDOVER=<the reversed word>. Nothing else.`,
    '',
    reporting === 'mcp'
      ? 'Report it by calling report_done with that line as the summary, status "success".'
      : 'Report it in the DONE report line described below, as the summary.'
  ].join('\n')
  return `${body}\n\n${buildTaskContract({ role: WORKER_ROLE_ID, reporting })}`
}

/** A repository with one commit — the minimum `git worktree add` accepts. */
function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'vertragus-live-'))
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: repo, stdio: 'pipe' })
  }
  git('init', '-b', 'main')
  git('config', 'user.email', 'live@vertragus.test')
  git('config', 'user.name', 'Vertragus Live')
  writeFileSync(join(repo, 'README.md'), '# live probe\n')
  git('add', '.')
  git('commit', '-m', 'live probe base')
  return repo
}

describe.skipIf(!LIVE)('live handover', () => {
  let mcp: McpServerHandle
  let repo: string
  let configDir: string

  beforeAll(async () => {
    mcp = await startMcpServer()
    repo = makeRepo()
    configDir = mkdtempSync(join(tmpdir(), 'vertragus-live-config-'))
    mkdirSync(logDir, { recursive: true })
  })

  afterAll(async () => {
    await mcp?.close()
    // Best effort: a CLI that has not fully released its worktree keeps the
    // directory locked on Windows, and a temp leftover must never turn a
    // passing probe into a failing one.
    for (const dir of [repo, configDir]) {
      if (!dir) continue
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch (error) {
        console.warn(`[live] could not remove ${dir}:`, error)
      }
    }
  })

  for (const providerId of PROVIDERS) {
    it(
      `delivers a complete assignment to ${providerId} and gets it executed`,
      async () => {
        const providers = providerPresets()
        const provider = providers.find((candidate) => candidate.id === providerId)
        expect(provider, `unknown provider preset "${providerId}"`).toBeDefined()

        const profile = profileSchema.parse({
          id: `live-${providerId}`,
          name: `Live ${providerId}`,
          repoPath: repo,
          orchestrator: { providerId },
          slots: [
            {
              id: 'live-worker',
              roleId: WORKER_ROLE_ID,
              providerId,
              // Empty leaves the CLI on its own default, which is what the app
              // does when a slot names no model.
              ...(process.env.VERTRAGUS_LIVE_MODEL ? { model: process.env.VERTRAGUS_LIVE_MODEL } : {})
            }
          ],
          maxSubagents: 1
        })

        // Raw stream, captured from the moment the agent is registered — i.e.
        // before the seed writes anything. `readOutput` deliberately collapses
        // TUI redraws; a post-mortem needs the bytes, redraws and all.
        const raw: string[] = []
        const registry = new FakeRegistry()
        const register = registry.registerAgent.bind(registry)
        registry.registerAgent = (entry): void => {
          register(entry)
          entry.pty.onData((data) => raw.push(data))
        }

        const workspace = new Workspace(
          { profile, name: `Live${Date.now()}` },
          {
            registry,
            windows: new FakeWindows(),
            configDir,
            providers,
            roleTemplates: BUILTIN_ROLE_TEMPLATES
          }
        )
        const registered = mcp.registerWorkspace(workspace.mcpContext())
        workspace.attachMcp(registered)
        workspace.attachQuestions(registered.runtime.questions)

        const seen: AgentEvent[] = []
        const off = workspace.events.onPush((event) => seen.push(event))

        try {
          const reporting = workspace.reportingMode(WORKER_ROLE_ID)
          const started = await workspace.startAgent({
            role: WORKER_ROLE_ID,
            task: probeTask(reporting)
          })

          const deadline = Date.now() + REPORT_TIMEOUT_MS
          let done: AgentEvent | undefined
          while (Date.now() < deadline) {
            done = seen.find(
              (event) => event.type === 'agent_done' && event.agentId === started.agentId
            )
            if (done) break
            const exited = seen.find(
              (event) => event.type === 'agent_exited' && event.agentId === started.agentId
            )
            if (exited) break
            await new Promise((resolve) => setTimeout(resolve, 500))
          }

          const tail = await workspace.readOutput(started.agentId, 2_000)
          // Printed and written out unconditionally: a live probe that fails is
          // only useful if the terminal it failed in is readable afterwards.
          const logFile = join(logDir, `${providerId}.log`)
          writeFileSync(logFile, `${JSON.stringify(seen, null, 2)}\n\n${tail}`)
          writeFileSync(join(logDir, `${providerId}.raw.log`), raw.join(''))
          console.log(
            `\n===== ${providerId} scrollback (full: ${logFile}) =====\n` +
              `${tail.slice(-6_000)}\n===== end =====\n`
          )

          expect(done, `no agent_done from ${providerId} within ${REPORT_TIMEOUT_MS} ms`).toBeDefined()
          expect(JSON.stringify(done)).toContain(EXPECTED)
        } finally {
          off()
          await workspace.close()
          mcp.unregisterWorkspace(workspace.workspaceId)
        }
      },
      REPORT_TIMEOUT_MS + 60_000
    )
  }

  /**
   * The whole chain, with nothing faked: a real orchestrator CLI is booted,
   * gets its goal typed in the way the user types it into the panel's window,
   * and has to hand a task to a real subagent through `start_agent` — which
   * seeds that second CLI. Two live handovers, one after the other, plus the
   * MCP round trip between them.
   *
   *   VERTRAGUS_LIVE=1 VERTRAGUS_LIVE_LOOP=1 pnpm vitest run tests/live/…
   */
  it.skipIf(process.env.VERTRAGUS_LIVE_LOOP !== '1')(
    'lets a real orchestrator hand a real task to a real subagent',
    async () => {
      const providerId = process.env.VERTRAGUS_LIVE_LOOP_PROVIDER ?? 'claude'
      const providers = providerPresets()
      const profile = profileSchema.parse({
        id: 'live-loop',
        name: 'Live loop',
        repoPath: repo,
        orchestrator: { providerId },
        slots: [{ id: 'live-worker', roleId: WORKER_ROLE_ID, providerId }],
        maxSubagents: 1
      })

      const workspace = new Workspace(
        { profile, name: `Loop${Date.now()}` },
        {
          registry: new FakeRegistry(),
          windows: new FakeWindows(),
          configDir,
          providers,
          roleTemplates: BUILTIN_ROLE_TEMPLATES
        }
      )
      const registered = mcp.registerWorkspace(workspace.mcpContext())
      workspace.attachMcp(registered)
      workspace.attachQuestions(registered.runtime.questions)

      const seen: AgentEvent[] = []
      const off = workspace.events.onPush((event) => seen.push(event))

      try {
        const orchestrator = await workspace.startOrchestrator()
        // The goal, exactly as a user types it into the orchestrator window.
        await workspace.sendToAgent(
          orchestrator.agentId,
          [
            'This is a delivery probe of the handover machinery, not development work.',
            'Call start_agent ONCE, role "worker", and pass this task VERBATIM as the',
            'task text — copy it exactly, do not rewrite, shorten or reinterpret it:',
            '',
            `Take the word ${SECRET}, reverse its letters and call report_done with the`,
            'summary HANDOVER=<the reversed word> and status success. Do not read the',
            'repository, do not edit any file, do not run any command, do not commit.',
            '',
            'Then wait with await_events and tell me the summary it reported.',
            'Do not do the reversing yourself and do not invent a different task —',
            'the delegation IS the thing under test.'
          ].join('\n')
        )

        const deadline = Date.now() + REPORT_TIMEOUT_MS
        let done: AgentEvent | undefined
        while (Date.now() < deadline) {
          done = seen.find(
            (event) => event.type === 'agent_done' && event.agentId !== orchestrator.agentId
          )
          if (done) break
          await new Promise((resolve) => setTimeout(resolve, 500))
        }

        const orchestratorTail = await workspace.readOutput(orchestrator.agentId, 2_000)
        writeFileSync(
          join(logDir, 'loop.log'),
          `${JSON.stringify(seen, null, 2)}\n\n${orchestratorTail}`
        )
        console.log(`\n===== orchestrator tail =====\n${orchestratorTail.slice(-4_000)}\n=====\n`)

        expect(
          seen.some((event) => event.type === 'agent_started'),
          'the orchestrator never started a subagent'
        ).toBe(true)
        expect(done, `no subagent report within ${REPORT_TIMEOUT_MS} ms`).toBeDefined()
        expect(JSON.stringify(done)).toContain(EXPECTED)
      } finally {
        off()
        await workspace.close()
        mcp.unregisterWorkspace(workspace.workspaceId)
      }
    },
    REPORT_TIMEOUT_MS + 120_000
  )
})
