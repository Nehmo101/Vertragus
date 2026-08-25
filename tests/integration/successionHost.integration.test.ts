/**
 * S3 × C6 integration: the HOST replaces a dead orchestrator, over a REAL
 * repository and a REAL MCP server.
 *
 * Same recipe as `successionBoard.integration.test.ts` (real `git worktree`,
 * real HTTP MCP, fake spawn/seed — no CLI processes), but the trigger is the
 * one the incumbent can no longer pull: its process is gone, the team is still
 * running, and a human presses "Replace orchestrator". `stopWorkspace` would
 * throw the run away instead.
 *
 * What this pins, end to end:
 * - the predecessor's token is dead the moment the successor exists (401),
 *   even though nobody could ask the predecessor to hand it over;
 * - the subagent, its worktree and its MCP session survive the cutover;
 * - the seat moves to the successor, while the dead predecessor's record is
 *   left alone — window not closed, no kill, no `orchestrator_exited` from the
 *   cutover: that corpse is the post-mortem the button was pressed in front of;
 * - C3: the `headSha` the package carries for an agent is the commit
 *   `snapshotDone` made at report time, not the pre-commit HEAD;
 * - the package is frozen in the RUN directory and renamed to
 *   `succession.consumed.json` by the cutover, so a later resume cannot
 *   replay it.
 *
 * No sleeps: every git step is awaited, every event is long-polled.
 */
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startMcpServer, type McpServerHandle } from '@main/mcp/server'
import { readSuccessionPackage } from '@main/workspace/resume'
import type { AgentEvent } from '@shared/schema/events'
import type { OrchestratorHandoffPackage } from '@shared/schema/handoff'
import { Workspace, type WorkspaceDeps } from '@main/workspace/Workspace'
import {
  FakePty,
  FakeRegistry,
  FakeWindows,
  fakeSeed,
  fakeSpawn,
  sequentialIds,
  testProfile,
  testProviders,
  type RecordedSpawn
} from '@main/workspace/testing'

const execFileAsync = promisify(execFile)
const TEST_TIMEOUT = 30_000

const BUGGY = 'export const add = (a, b) => a - b\n'
const FIXED = 'export const add = (a, b) => a + b\n'

let repo: string

async function git(args: string[], cwd = repo): Promise<string> {
  const { stdout } = await execFileAsync(
    'git',
    ['-c', 'user.name=Eval', '-c', 'user.email=eval@localhost', ...args],
    { cwd, windowsHide: true }
  )
  return stdout
}

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'vertragus-succession-host-'))
  await git(['init', '--initial-branch=main'])
  await mkdir(join(repo, 'src'), { recursive: true })
  await writeFile(join(repo, 'src', 'math.js'), BUGGY, 'utf8')
  await git(['add', '-A'])
  await git(['commit', '-m', 'seed: math with a planted bug', '--no-verify'])
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

type ToolResult = Record<string, unknown> & { __isError: boolean; __text: string }

async function callOn(
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
): Promise<ToolResult> {
  const result = (await client.callTool({ name, arguments: args })) as {
    content?: Array<{ type: string; text?: string }>
    isError?: boolean
  }
  const text = (result.content ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('')
  let json: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed && typeof parsed === 'object') json = parsed as Record<string, unknown>
  } catch {
    json = {}
  }
  return { ...json, __isError: result.isError === true, __text: text }
}

/** Long-poll one client's await_events until `predicate` holds. Never polls. */
async function collectUntil(
  client: Client,
  predicate: (events: AgentEvent[]) => boolean,
  startCursor = 0
): Promise<{ events: AgentEvent[]; cursor: number }> {
  const collected: AgentEvent[] = []
  let cursor = startCursor
  for (let round = 1; round <= 12; round++) {
    const result = (await callOn(client, 'await_events', {
      cursor,
      timeoutSec: 15
    })) as unknown as { events: AgentEvent[]; cursor: number }
    collected.push(...result.events)
    cursor = result.cursor
    if (predicate(collected)) return { events: collected, cursor }
  }
  throw new Error(`Predicate never satisfied. Saw: ${collected.map((e) => e.type).join(', ')}`)
}

interface Harness {
  handle: McpServerHandle
  workspace: Workspace
  spawnCalls: RecordedSpawn[]
  /** The corpse is evidence: nothing about the cutover may close its window. */
  windows: FakeWindows
  orchestratorUrl(): string
  subagentUrl(agentId: string): string
  connect(url: string): Promise<Client>
  dispose(): Promise<void>
}

async function makeHarness(): Promise<Harness> {
  const handle = await startMcpServer()
  const spawner = fakeSpawn()
  const windows = new FakeWindows()
  const workspace = new Workspace(
    {
      profile: testProfile({
        repoPath: repo,
        slots: [{ id: 'slot-worker', roleId: 'worker', providerId: 'claude' }]
      }),
      name: 'Host'
    },
    {
      registry: new FakeRegistry(),
      windows,
      configDir: join(repo, '.vertragus-config'),
      providers: testProviders(),
      // Fake processes, REAL worktrees AND a real package on disk: the
      // persist path is part of what this test measures.
      spawn: spawner.spawn as unknown as WorkspaceDeps['spawn'],
      seed: fakeSeed().seed as unknown as WorkspaceDeps['seed'],
      createPty: () => new FakePty(),
      newId: sequentialIds('agent')
    }
  )
  const registered = handle.registerWorkspace(workspace.mcpContext())
  workspace.attachMcp({
    ...registered,
    // Fake spawn never handshakes; without this the host would wait 20s then
    // hold Enter for a session that will never arrive.
    waitForSession: async () => true
  })
  workspace.attachQuestions(registered.runtime.questions)

  const clients: Client[] = []
  return {
    handle,
    workspace,
    spawnCalls: spawner.calls,
    windows,
    orchestratorUrl: () => registered.orchestratorUrl,
    subagentUrl: (agentId) => registered.subagentUrl(agentId),
    async connect(url) {
      const client = new Client({ name: 'fake-driver', version: '1.0.0' })
      await client.connect(new StreamableHTTPClientTransport(new URL(url)))
      clients.push(client)
      return client
    },
    async dispose() {
      for (const client of clients) await client.close().catch(() => undefined)
      await workspace.close()
      await handle.close()
    }
  }
}

describe('S3 host-triggered replacement of a DEAD orchestrator', () => {
  it(
    'rotates the token, keeps the team, and freezes the package in the run directory',
    async () => {
      const harness = await makeHarness()
      const { workspace } = harness
      try {
        const predecessor = await workspace.startOrchestrator()
        const orchestrator = await harness.connect(harness.orchestratorUrl())

        const started = await callOn(orchestrator, 'start_agent', {
          role: 'worker',
          task: 'Fix add() in src/math.js.'
        })
        expect(started.__isError).toBe(false)
        const workerId = String(started.agentId)
        const workerPath = String(started.worktreePath)
        await collectUntil(orchestrator, (events) =>
          events.some((event) => event.type === 'agent_started' && event.agentId === workerId)
        )

        // The worker does its work and reports through its own session — C3
        // commits the dirty worktree at done-time.
        await writeFile(join(workerPath, 'src', 'math.js'), FIXED, 'utf8')
        const worker = await harness.connect(harness.subagentUrl(workerId))
        expect(await callOn(worker, 'report_done', { summary: 'Fixed add to a + b.' })).toMatchObject(
          { ok: true }
        )
        const committed = (await git(['rev-parse', 'HEAD'], workerPath)).trim()

        // --- the orchestrator dies, nobody drives the loop ------------------
        const oldOrchestratorUrl = harness.orchestratorUrl()
        harness.spawnCalls[0]!.pty.exit({ exitCode: 137 })
        expect(workspace.orchestratorAlive).toBe(false)

        const eventsBeforeCutover = workspace.events.all().length
        const successor = await workspace.replaceOrchestratorFromHost()

        expect(successor.agentId).not.toBe(predecessor.agentId)
        expect(workspace.orchestratorAlive).toBe(true)
        // The seat moved: a second orchestrator was spawned, and it is the one
        // the workspace now drives the loop through.
        const orchestratorSpawns = harness.spawnCalls.filter(
          (call) => call.input.kind === 'orchestrator'
        )
        expect(orchestratorSpawns).toHaveLength(2)
        expect(workspace.orchestrator?.agentId).toBe(successor.agentId)

        // The dead-path invariants. A DEAD predecessor is not terminated: its
        // window and scrollback are the post-mortem the user pressed the
        // button in front of, and the cutover must not close them or announce
        // a death the workspace already reported when the process exited.
        expect(harness.windows.closed).not.toContain(predecessor.agentId)
        expect(harness.spawnCalls[0]!.pty.killed).toBe(0)
        const cutoverEvents = workspace.events.all().slice(eventsBeforeCutover)
        expect(cutoverEvents.map((event) => event.type)).not.toContain('orchestrator_exited')
        expect(cutoverEvents.map((event) => event.type)).toContain('orchestrator_started')

        // The dead predecessor's URL is dead too — a crashed CLI that comes
        // back (a supervisor restart) must not find a second live seat.
        const intruder = new Client({ name: 'predecessor', version: '1.0.0' })
        await expect(
          intruder.connect(new StreamableHTTPClientTransport(new URL(oldOrchestratorUrl)))
        ).rejects.toMatchObject({ code: 401 })

        // The team survived, and the successor can drive it under the new token.
        const successorClient = await harness.connect(harness.orchestratorUrl())
        const listed = await callOn(successorClient, 'list_agents')
        expect((listed.agents as Array<Record<string, unknown>>).map((agent) => agent.agentId)).toEqual(
          [workerId]
        )

        // The package: written next to the journal, then retired by the
        // cutover so a later resume cannot replay it.
        const dir = join(repo, '.vertragus', 'runs', workspace.workspaceId)
        expect(existsSync(join(dir, 'succession.json'))).toBe(false)
        const pkg = JSON.parse(
          readFileSync(join(dir, 'succession.consumed.json'), 'utf8')
        ) as OrchestratorHandoffPackage
        expect(pkg).toMatchObject({ reason: 'user_requested', kind: 'orchestrator_succession' })
        expect(await readSuccessionPackage(repo, workspace.workspaceId)).toBeUndefined()

        // C3: the packaged SHA is the snapshot commit, so "finished" points at
        // a tree that actually holds the fix.
        const packagedWorker = pkg.agents.find((agent) => agent.agentId === workerId)!
        expect(packagedWorker.headSha).toBe(committed)
        expect(packagedWorker.uncommitted).toBe(false)
        expect(packagedWorker.lastSummary).toBe('Fixed add to a + b.')
      } finally {
        await harness.dispose()
      }
    },
    TEST_TIMEOUT
  )
})
