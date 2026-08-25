/**
 * S4 × C6 integration: the task board across an orchestrator succession, over
 * a REAL repository and a REAL MCP server.
 *
 * The loopEval recipe (real `git worktree` machinery, fake spawn/seed — no CLI
 * processes) plus the mcpLoop recipe (real HTTP server, tools driven by MCP
 * SDK clients exactly as the models would). The board is a real
 * {@link createTaskBoard} wired the way the WorkspaceManager wires it: on the
 * MCP runtime (the tool layer owns the calls) AND handed to the Workspace
 * (the succession package needs it).
 *
 * The chain under test is the plan's whole life across a handoff:
 * create → blocked → claim via start_agent{taskId} → noteReport on report_done
 * → CAS complete (with one honest stale-revision round-trip) →
 * requestSuccession → the package carries the board uncut while prose is
 * truncated → the LIVE board is untouched by the cutover → the successor works
 * under the rotated token while the predecessor's token gets a flat 401.
 *
 * No sleeps: every git step is awaited, every event is long-polled.
 */
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startMcpServer, type McpServerHandle } from '@main/mcp/server'
import type { AgentEvent } from '@shared/schema/events'
import type { OrchestratorHandoffPackage } from '@shared/schema/handoff'
import { createTaskBoard, type TaskBoard } from '@main/workspace/taskBoard'
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

async function git(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    'git',
    ['-c', 'user.name=Eval', '-c', 'user.email=eval@localhost', ...args],
    { cwd: repo, windowsHide: true }
  )
  return stdout
}

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'vertragus-succession-board-'))
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
  board: TaskBoard
  spawnCalls: RecordedSpawn[]
  /** The one succession package the workspace persisted. */
  packages: OrchestratorHandoffPackage[]
  orchestratorUrl(): string
  subagentUrl(agentId: string): string
  connect(url: string): Promise<Client>
  dispose(): Promise<void>
}

async function makeHarness(): Promise<Harness> {
  const handle = await startMcpServer()
  const spawner = fakeSpawn()
  const packages: OrchestratorHandoffPackage[] = []
  const workspace = new Workspace(
    {
      profile: testProfile({
        repoPath: repo,
        slots: [
          { id: 'slot-worker', roleId: 'worker', providerId: 'claude' },
          { id: 'slot-tester', roleId: 'tester', providerId: 'claude' }
        ]
      }),
      name: 'Board'
    },
    {
      registry: new FakeRegistry(),
      windows: new FakeWindows(),
      configDir: join(repo, '.vertragus-config'),
      providers: testProviders(),
      // Fake processes, REAL worktrees: createWorktree/worktreeDeps stay unset.
      spawn: spawner.spawn as unknown as WorkspaceDeps['spawn'],
      seed: fakeSeed().seed as unknown as WorkspaceDeps['seed'],
      createPty: () => new FakePty(),
      newId: sequentialIds('agent'),
      writeSuccession: (pkg) => packages.push(pkg)
    }
  )
  // Mirror the WorkspaceManager wiring exactly: register, attach URLs and the
  // shared question registry, then install ONE real board in both places —
  // the runtime (tool calls) and the workspace (succession package).
  const registered = handle.registerWorkspace(workspace.mcpContext())
  workspace.attachMcp({
    ...registered,
    // Fake spawn never handshakes; without this the host would wait 20s then
    // hold Enter for a session that will never arrive.
    waitForSession: async () => true
  })
  workspace.attachQuestions(registered.runtime.questions)
  const board = createTaskBoard(repo, workspace.workspaceId)
  registered.runtime.taskBoard = board
  workspace.attachTaskBoard(board)

  const clients: Client[] = []
  return {
    handle,
    workspace,
    board,
    spawnCalls: spawner.calls,
    packages,
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
      // Settle the board's snapshot chain before the temp repo is removed.
      await board.flush()
    }
  }
}

describe('S4 board across succession — plan survives, live board untouched, token rotates', () => {
  it(
    'runs the whole chain on a real repository',
    async () => {
      const harness = await makeHarness()
      const { workspace, board } = harness
      try {
        await workspace.startOrchestrator()
        const orchestrator = await harness.connect(harness.orchestratorUrl())

        // The plan, as the model would write it: task-2 waits on task-1.
        const created1 = await callOn(orchestrator, 'task_create', {
          subject: 'fix add()',
          description: 'Fix add() in src/math.js — it subtracts.'
        })
        expect(created1).toMatchObject({ taskId: 'task-1', revision: 1 })
        const created2 = await callOn(orchestrator, 'task_create', {
          subject: 'verify',
          blockedBy: ['task-1']
        })
        expect(created2).toMatchObject({ taskId: 'task-2', revision: 1 })

        // Blocked means blocked: task-2 is pending but NOT ready.
        const listed = await callOn(orchestrator, 'task_list')
        const rows = listed.tasks as Array<Record<string, unknown>>
        expect(rows.find((row) => row.taskId === 'task-2')).toMatchObject({ ready: false })

        // start_agent{taskId} claims mechanically: owner + in_progress, and the
        // board task's subject/description ride into the seed as host truth.
        const started = await callOn(orchestrator, 'start_agent', {
          role: 'worker',
          task: 'Fix add() in src/math.js.',
          taskId: 'task-1'
        })
        expect(started.__isError).toBe(false)
        expect(started.taskId).toBe('task-1')
        expect(started.warning).toBeUndefined()
        const workerId = String(started.agentId)
        const workerPath = String(started.worktreePath)
        await collectUntil(orchestrator, (events) =>
          events.some((event) => event.type === 'agent_started' && event.agentId === workerId)
        )
        expect(board.get('task-1')).toMatchObject({
          status: 'in_progress',
          ownerAgentId: workerId,
          revision: 2
        })

        // The "worker" fixes the bug in ITS OWN real worktree and reports done
        // through its own MCP session — C3 snapshots the fix into a commit,
        // and the same path lands as lastReport on the board (noteReport).
        await writeFile(join(workerPath, 'src', 'math.js'), FIXED, 'utf8')
        const worker = await harness.connect(harness.subagentUrl(workerId))
        const reported = await callOn(worker, 'report_done', { summary: 'Fixed add to a + b.' })
        expect(reported).toMatchObject({ ok: true })

        const afterReport = board.get('task-1')!
        expect(afterReport.revision).toBe(3)
        expect(afterReport.lastReport).toMatchObject({
          status: 'success',
          summary: 'Fixed add to a + b.'
        })
        expect(afterReport.lastReport!.headSha).toMatch(/^[0-9a-f]{40}$/)

        // CAS as designed: completing with the pre-report revision is refused,
        // and the error payload CARRIES the current task — reconcile, retry.
        const stale = await callOn(orchestrator, 'task_update', {
          taskId: 'task-1',
          expectedRevision: 2,
          action: 'complete'
        })
        expect(stale.__isError).toBe(true)
        expect(stale.error).toBe('stale_revision')
        const currentTask = stale.task as { taskId: string; revision: number }
        expect(currentTask).toMatchObject({ taskId: 'task-1', revision: 3 })
        const completed = await callOn(orchestrator, 'task_update', {
          taskId: 'task-1',
          expectedRevision: currentTask.revision,
          action: 'complete'
        })
        expect(completed.__isError).toBe(false)
        expect(completed.task).toMatchObject({ status: 'completed', revision: 4 })

        // --- Succession, mid-run ------------------------------------------
        const boardBefore = board.snapshot()
        const oldOrchestratorUrl = harness.orchestratorUrl()
        // Overlong decisions force the package's truncation machinery to run;
        // the board rows must come through it whole regardless.
        const starting = workspace.requestSuccession({
          reason: 'long_run',
          goal: { current: 'Verify the add() fix, then finish.' },
          decisions: Array.from({ length: 5 }, (_, i) => `decision ${i}: ${'x'.repeat(900)}`),
          nextActions: ['start the verify task once ready']
        })

        // The package was persisted synchronously with the request.
        expect(harness.packages).toHaveLength(1)
        const pkg = harness.packages[0]!
        expect(pkg.tasks).toEqual([
          {
            taskId: 'task-1',
            revision: 4,
            subject: 'fix add()',
            status: 'completed',
            ownerAgentId: workerId,
            blockedBy: []
          },
          { taskId: 'task-2', revision: 1, subject: 'verify', status: 'pending', blockedBy: ['task-1'] }
        ])
        // Prose was demonstrably truncated; the board rows stayed whole.
        expect(pkg.limits.truncated).toContain('decisions')
        for (const decision of pkg.decisions) expect(decision.length).toBeLessThanOrEqual(300)

        await starting.ready

        // Cutover never touches the LIVE board — it is host state, not context.
        expect(board.snapshot()).toEqual(boardBefore)

        // The successor's seed prose names the board instead of rebuilding it.
        const orchestratorSpawns = harness.spawnCalls.filter(
          (call) => call.input.kind === 'orchestrator'
        )
        expect(orchestratorSpawns).toHaveLength(2)
        const successorPrompt = orchestratorSpawns[1]!.input.systemPrompt ?? ''
        expect(successorPrompt).toContain('The task board is HOST state and survived this handoff')
        expect(successorPrompt).toContain('task-1')
        expect(successorPrompt).toContain('task-2')

        // The predecessor's token is dead: a fresh connect gets a flat 401.
        const intruder = new Client({ name: 'predecessor', version: '1.0.0' })
        await expect(
          intruder.connect(new StreamableHTTPClientTransport(new URL(oldOrchestratorUrl)))
        ).rejects.toMatchObject({ code: 401 })

        // The successor works under the rotated token — and task-2 is ready
        // now that task-1 is completed.
        const successor = await harness.connect(harness.orchestratorUrl())
        const successorList = await callOn(successor, 'task_list')
        const successorRows = successorList.tasks as Array<Record<string, unknown>>
        expect(successorRows.find((row) => row.taskId === 'task-2')).toMatchObject({
          status: 'pending',
          ready: true
        })

        // And the successor claims it through the same mechanical path.
        const verify = await callOn(successor, 'start_agent', {
          role: 'tester',
          task: 'Verify add() adds.',
          taskId: 'task-2'
        })
        expect(verify.__isError).toBe(false)
        expect(verify.taskId).toBe('task-2')
        const testerId = String(verify.agentId)
        await collectUntil(
          successor,
          (events) =>
            events.some((event) => event.type === 'agent_started' && event.agentId === testerId),
          pkg.eventCursor
        )
        expect(board.get('task-2')).toMatchObject({ status: 'in_progress', ownerAgentId: testerId })
      } finally {
        await harness.dispose()
      }
    },
    TEST_TIMEOUT
  )
})
