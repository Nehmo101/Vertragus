/**
 * LIVE succession probe — the orchestrator seat, replaced under a REAL CLI.
 *
 * `successionBoard` and `successionHost` prove the cutover against fake
 * processes: honest about state machines, tokens and files, silent about the
 * one thing that keeps breaking — whether a real CLI accepts a multi-KB
 * successor seed, whether the rotated MCP URL actually attaches, and whether
 * the predecessor's process really lets go. That is what this file measures,
 * on the production path:
 *
 *   temp git repo → real MCP server → real orchestrator CLI + real subagent
 *     → host-triggered replaceOrchestratorFromHost()
 *     → rotated token → real successor CLI seeded with the package
 *
 * The trigger is the HOST, never the model: `request_succession` would make
 * the probe depend on an incumbent choosing to call a tool, and a probe that
 * only runs when the model cooperates measures the model, not the machinery.
 *
 *   VERTRAGUS_LIVE=1 pnpm vitest run tests/live/succession.live.test.ts
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
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
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

/** How long the successor gets to attach and take the loop. */
const SUCCESSION_TIMEOUT_MS = Number(process.env.VERTRAGUS_LIVE_TIMEOUT_MS ?? 180_000)

/** Where the full scrollback of each probe is written for post-mortems. */
const logDir = process.env.VERTRAGUS_LIVE_LOG_DIR ?? join(tmpdir(), 'vertragus-live-logs')

/** The word the subagent has to reverse — the same self-verifying probe task. */
const SECRET = 'PALINDROM'

/**
 * The planted `ask_orchestrator` ticket. It exists before the cutover, must
 * survive it (same PendingQuestions registry), and is what the successor is
 * told to clear first.
 */
const PLANTED_QUESTION =
  'Which branch should the fix land on, main or develop? Answer this ticket first.'

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
  const repo = mkdtempSync(join(tmpdir(), 'vertragus-live-succession-'))
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: repo, stdio: 'pipe' })
  }
  git('init', '-b', 'main')
  git('config', 'user.email', 'live@vertragus.test')
  git('config', 'user.name', 'Vertragus Live')
  writeFileSync(join(repo, 'README.md'), '# live succession probe\n')
  git('add', '.')
  git('commit', '-m', 'live probe base')
  return repo
}

describe.skipIf(!LIVE)('live succession', () => {
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
      `replaces a live ${providerId} orchestrator and hands the run to the successor`,
      async () => {
        const providers = providerPresets()
        const provider = providers.find((candidate) => candidate.id === providerId)
        expect(provider, `unknown provider preset "${providerId}"`).toBeDefined()

        const profile = profileSchema.parse({
          id: `live-succession-${providerId}`,
          name: `Live succession ${providerId}`,
          repoPath: repo,
          orchestrator: { providerId },
          slots: [
            {
              id: 'live-worker',
              roleId: WORKER_ROLE_ID,
              providerId,
              ...(process.env.VERTRAGUS_LIVE_MODEL ? { model: process.env.VERTRAGUS_LIVE_MODEL } : {})
            }
          ],
          maxSubagents: 1
        })

        const raw: string[] = []
        const registry = new FakeRegistry()
        const register = registry.registerAgent.bind(registry)
        registry.registerAgent = (entry): void => {
          register(entry)
          entry.pty.onData((data) => raw.push(data))
        }

        const workspace = new Workspace(
          { profile, name: `Succession${Date.now()}` },
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
        // Any orchestrator tool call after the cutover can only be the
        // successor's — the predecessor's token is dead by then.
        let toolCalls = 0
        registered.runtime.onOrchestratorToolCall = () => {
          toolCalls += 1
        }

        try {
          const predecessor = await workspace.startOrchestrator()
          // A real subagent, started by the HOST: the roster the successor
          // inherits must be a real one, and start_agent by the incumbent
          // would make the probe depend on the model delegating.
          const worker = await workspace.startAgent({
            role: WORKER_ROLE_ID,
            task: probeTask(workspace.reportingMode(WORKER_ROLE_ID))
          })
          const planted = registered.runtime.questions.create(worker.agentId, PLANTED_QUESTION)

          const oldOrchestratorUrl = registered.orchestratorUrl
          toolCalls = 0

          const successor = await workspace.replaceOrchestratorFromHost()

          expect(successor.agentId).not.toBe(predecessor.agentId)
          expect(workspace.orchestratorAlive).toBe(true)
          expect(workspace.orchestrator?.agentId).toBe(successor.agentId)
          // Exactly one live orchestrator: the predecessor was killed and
          // unregistered at cutover, the successor holds the seat.
          expect(registry.getAgent(predecessor.agentId)).toBeUndefined()
          expect(registry.getAgent(successor.agentId)).toBeDefined()
          // The team survived its orchestrator — that is the whole point.
          expect(workspace.listAgents().map((agent) => agent.agentId)).toContain(worker.agentId)

          // The predecessor's URL is dead: two CLIs on one queue is the race
          // the token rotation exists to make impossible.
          const intruder = new Client({ name: 'predecessor', version: '1.0.0' })
          await expect(
            intruder.connect(new StreamableHTTPClientTransport(new URL(oldOrchestratorUrl)))
          ).rejects.toMatchObject({ code: 401 })

          // The successor took the loop: it either cleared the planted ticket
          // (send_to_agent{questionId}) or parked on await_events. Either is a
          // live CLI attached under the rotated token; which one it picks is
          // the model's business, not the machinery's.
          const deadline = Date.now() + SUCCESSION_TIMEOUT_MS
          let answered = false
          while (Date.now() < deadline) {
            answered = registered.runtime.questions.get(planted.questionId) === undefined
            if (answered || toolCalls > 0) break
            await new Promise((resolve) => setTimeout(resolve, 500))
          }

          const successorTail = await workspace.readOutput(successor.agentId, 2_000)
          // Printed and written out unconditionally: a live probe that fails is
          // only useful if the terminal it failed in is readable afterwards.
          const logFile = join(logDir, `succession-${providerId}.log`)
          writeFileSync(logFile, `${JSON.stringify(seen, null, 2)}\n\n${successorTail}`)
          writeFileSync(join(logDir, `succession-${providerId}.raw.log`), raw.join(''))
          console.log(
            `\n===== ${providerId} successor scrollback (full: ${logFile}) =====\n` +
              `${successorTail.slice(-6_000)}\n===== end =====\n`
          )

          expect(
            answered || toolCalls > 0,
            `the ${providerId} successor neither answered the planted question nor called a tool ` +
              `within ${SUCCESSION_TIMEOUT_MS} ms`
          ).toBe(true)
          // The cutover is not a crash: succession must never look like one.
          expect(seen.some((event) => event.type === 'orchestrator_handoff_started')).toBe(true)
          expect(seen.some((event) => event.type === 'orchestrator_started')).toBe(true)
          expect(seen.some((event) => event.type === 'orchestrator_exited')).toBe(false)
        } finally {
          off()
          await workspace.close()
          mcp.unregisterWorkspace(workspace.workspaceId)
        }
      },
      SUCCESSION_TIMEOUT_MS + 120_000
    )
  }
})
