/**
 * The most important test in the repository: the whole orchestration loop over
 * a real HTTP server, across real process boundaries.
 *
 *   real MCP server (node:http, random port)
 *     ↑ fake orchestrator = real MCP SDK client
 *     ↑ fake subagents    = scripts/fake-agent.mjs as child processes
 *
 * Nothing here sleeps to synchronise. Every step waits for an actual event, an
 * actual line of child output, or an actual `wait()` registration; the timeouts
 * are upper bounds only. If this test ever needs a sleep to pass, the waiter
 * mechanism is broken.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { EventQueue } from '@main/mcp/eventQueue'
import { buildSubagentUrl, startMcpServer, type McpServerHandle } from '@main/mcp/server'
import type {
  AgentHost,
  AgentSummary,
  StartAgentInput,
  StartingAgent,
  WorkspaceMcpContext
} from '@main/mcp/types'
import type { AgentEvent } from '@shared/schema/events'

const FAKE_AGENT = fileURLToPath(new URL('../../scripts/fake-agent.mjs', import.meta.url))
const TEST_TIMEOUT = 30_000

/** A child process pretending to be an interactive agent. */
interface FakeProcess {
  summary: AgentSummary
  child: ChildProcessWithoutNullStreams
  lines: string[]
  partial: string
  stopping: boolean
  exited: Promise<number | null>
  waiters: Array<{ prefix: string; resolve: (line: string) => void }>
}

/**
 * An AgentHost that really spawns processes. It owns exactly one event kind —
 * `agent_exited` — which is the contract every real host implementation
 * follows; every other event comes from the MCP tools themselves. Integration
 * fake agents always speak MCP (not sentinel).
 */
class SpawningHost implements AgentHost {
  readonly processes = new Map<string, FakeProcess>()
  private counter = 0

  constructor(
    private readonly events: EventQueue,
    private readonly subagentUrl: (agentId: string) => string
  ) {}

  reportingMode(_role: string): AgentSummary['reporting'] {
    return 'mcp'
  }

  beginAgent(input: StartAgentInput): StartingAgent {
    const n = ++this.counter
    const agentId = `agent-${n}`
    // The task text carries the behaviour the fake agent should act out.
    const mode = /mode:([\w-]+)/.exec(input.task)?.[1] ?? 'done'
    const child = spawn(process.execPath, [FAKE_AGENT, this.subagentUrl(agentId), mode], {
      stdio: ['pipe', 'pipe', 'pipe']
    }) as ChildProcessWithoutNullStreams

    const record: FakeProcess = {
      summary: {
        agentId,
        name: `Cast ${n}`,
        role: input.role,
        status: 'running',
        model: input.model,
        // Every agent gets its own worktree and branch — this host fakes the invariant.
        worktreePath: `/worktrees/${agentId}`,
        branch: `vertragus/test/${agentId}`,
        lastOutputAgeSec: 0,
        reporting: 'mcp'
      },
      child,
      lines: [],
      partial: '',
      stopping: false,
      waiters: [],
      exited: new Promise((resolve) => child.once('exit', (code) => resolve(code)))
    }
    this.processes.set(agentId, record)

    const consume = (chunk: Buffer): void => {
      record.partial += chunk.toString('utf8')
      const parts = record.partial.split('\n')
      record.partial = parts.pop() ?? ''
      for (const raw of parts) {
        const line = raw.trim()
        record.lines.push(line)
        for (const waiter of [...record.waiters]) {
          if (!line.startsWith(waiter.prefix)) continue
          record.waiters.splice(record.waiters.indexOf(waiter), 1)
          waiter.resolve(line)
        }
      }
    }
    child.stdout.on('data', consume)
    child.stderr.on('data', consume)

    child.once('exit', (code) => {
      record.summary = { ...record.summary, status: 'exited' }
      // An intentional stop is reported by stop_agent, not as a surprise death.
      if (record.stopping) return
      this.events.push({
        type: 'agent_exited',
        agentId,
        name: record.summary.name,
        roleId: record.summary.role,
        exitCode: code,
        // Confirmed only when the agent reported a result before dying — an
        // unconfirmed exit is what the orchestrator must verify with read_output.
        confirmed: this.events
          .all()
          .some((event) => event.type === 'agent_done' && event.agentId === agentId)
      })
    })

    return {
      agentId,
      name: record.summary.name,
      role: record.summary.role,
      providerId: 'fake',
      model: record.summary.model,
      worktreePath: `/worktrees/${agentId}`,
      branch: `vertragus/test/${agentId}`,
      // `spawn` is synchronous and the fake needs no seed handshake — a begun
      // agent is a ready agent here.
      ready: Promise.resolve()
    }
  }

  async sendToAgent(agentId: string, text: string): Promise<void> {
    // A PTY receives typed text; here the child reads it from stdin.
    this.require(agentId).child.stdin.write(`${text.split('\n')[0]}\n`)
  }

  async stopAgent(agentId: string): Promise<boolean> {
    const record = this.processes.get(agentId)
    if (!record || record.summary.status !== 'running') return false
    record.stopping = true
    record.child.kill()
    await record.exited
    return true
  }

  async readOutput(agentId: string, lines: number): Promise<string> {
    return this.require(agentId).lines.slice(-lines).join('\n')
  }

  listAgents(): AgentSummary[] {
    return [...this.processes.values()].map((record) => record.summary)
  }

  /** Resolve once the agent prints a line with this prefix (past lines count). */
  waitForLine(agentId: string, prefix: string): Promise<string> {
    const record = this.require(agentId)
    const seen = record.lines.find((line) => line.startsWith(prefix))
    if (seen) return Promise.resolve(seen)
    return new Promise((resolve) => record.waiters.push({ prefix, resolve }))
  }

  killAll(): void {
    for (const record of this.processes.values()) {
      record.stopping = true
      if (record.summary.status === 'running') record.child.kill()
    }
  }

  private require(agentId: string): FakeProcess {
    const record = this.processes.get(agentId)
    if (!record) throw new Error(`Unknown agent ${agentId}`)
    return record
  }
}

type ToolResult = Record<string, unknown> & { __isError: boolean; __text: string }

interface Harness {
  handle: McpServerHandle
  host: SpawningHost
  events: EventQueue
  /** performance.now() at the moment each seq was pushed. */
  pushedAt: Map<number, number>
  /** Resolves the next time the server parks a reader on the queue. */
  nextQueueWait(): Promise<void>
  call(name: string, args?: Record<string, unknown>): Promise<ToolResult>
  dispose(): Promise<void>
}

interface HarnessOptions {
  perRole?: Record<string, number | undefined>
  maxTotal?: number
  askTimeoutMs?: number
}

let workspaceCounter = 0
const openHarnesses: Harness[] = []

async function makeHarness(options: HarnessOptions = {}): Promise<Harness> {
  const handle = await startMcpServer()
  const workspaceId = `ws-${++workspaceCounter}`
  const orchToken = `orch-${workspaceId}-secret`
  const subToken = `sub-${workspaceId}-secret`

  const events = new EventQueue()
  const pushedAt = new Map<number, number>()
  const originalPush = events.push.bind(events)
  events.push = (payload): AgentEvent => {
    const event = originalPush(payload)
    pushedAt.set(event.seq, performance.now())
    return event
  }

  // Instrument wait() so the test can synchronise on "a reader is parked"
  // without polling — this is what makes the latency assertion deterministic.
  const originalWait = events.wait.bind(events)
  const waitListeners: Array<() => void> = []
  events.wait = (cursor, timeoutMs, signal) => {
    const promise = originalWait(cursor, timeoutMs, signal)
    for (const listener of waitListeners.splice(0)) listener()
    return promise
  }

  const host = new SpawningHost(events, (agentId) =>
    buildSubagentUrl(handle.port, workspaceId, agentId, subToken)
  )

  const ctx: WorkspaceMcpContext = {
    workspaceId,
    workspaceName: 'Integration',
    repoPath: process.cwd(),
    orchToken,
    subToken,
    host,
    events,
    limits: { perRole: new Map(Object.entries(options.perRole ?? {})), maxTotal: options.maxTotal },
    roles: ['worker', 'reviewer'],
    askTimeoutMs: options.askTimeoutMs
  }

  const registered = handle.registerWorkspace(ctx)
  const orchestrator = new Client({ name: 'fake-orchestrator', version: '1.0.0' })
  await orchestrator.connect(new StreamableHTTPClientTransport(new URL(registered.orchestratorUrl)))

  const harness: Harness = {
    handle,
    host,
    events,
    pushedAt,
    nextQueueWait: () => new Promise<void>((resolve) => waitListeners.push(resolve)),
    async call(name, args = {}) {
      const result = (await orchestrator.callTool({ name, arguments: args })) as {
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
    },
    async dispose() {
      host.killAll()
      await orchestrator.close().catch(() => undefined)
      await handle.close()
    }
  }
  openHarnesses.push(harness)
  return harness
}

afterEach(async () => {
  while (openHarnesses.length > 0) await openHarnesses.pop()!.dispose()
})

interface AwaitResult {
  events: AgentEvent[]
  cursor: number
  agentsSummary: Array<Record<string, unknown>>
  note?: string
}

async function awaitEvents(harness: Harness, cursor: number, timeoutSec = 15): Promise<AwaitResult> {
  return (await harness.call('await_events', { cursor, timeoutSec })) as unknown as AwaitResult
}

/** Keep calling await_events until `predicate` holds. Blocks, never polls. */
async function collectUntil(
  harness: Harness,
  predicate: (events: AgentEvent[]) => boolean,
  startCursor = 0
): Promise<{ events: AgentEvent[]; cursor: number; rounds: number }> {
  const collected: AgentEvent[] = []
  let cursor = startCursor
  for (let round = 1; round <= 12; round++) {
    const result = await awaitEvents(harness, cursor)
    collected.push(...result.events)
    cursor = result.cursor
    if (predicate(collected)) return { events: collected, cursor, rounds: round }
  }
  throw new Error(`Predicate never satisfied. Saw: ${collected.map((e) => e.type).join(', ')}`)
}

describe('MCP orchestration loop', () => {
  it(
    '(a) delivers report_done to a parked await_events in well under 200 ms',
    async () => {
      const harness = await makeHarness()

      const started = await harness.call('start_agent', { role: 'worker', task: 'mode:done-on-cue' })
      expect(started.__isError).toBe(false)
      const agentId = String(started.agentId)

      // The agent_started event is already buffered, so this returns at once.
      const first = await awaitEvents(harness, 0)
      expect(first.events.map((event) => event.type)).toEqual(['agent_started'])
      expect(first.events[0]).toMatchObject({ agentId, roleId: 'worker' })

      // Wait until the child is connected, then park a reader and only cue the
      // report afterwards: the push provably happens while the reader waits.
      await harness.host.waitForLine(agentId, 'READY')
      const parked = harness.nextQueueWait()
      const pending = awaitEvents(harness, first.cursor)
      await parked

      await harness.call('send_to_agent', { agentId, text: 'go ahead' })

      const result = await pending
      const settledAt = performance.now()

      const done = result.events.find((event) => event.type === 'agent_done')
      expect(done).toBeDefined()
      expect(done).toMatchObject({ agentId, status: 'success' })

      // Push → orchestrator, including the full HTTP round trip back. A poll
      // loop of any realistic interval could not make this.
      const latency = settledAt - harness.pushedAt.get(done!.seq)!
      console.log(`[integration] push → orchestrator latency: ${latency.toFixed(1)} ms`)
      expect(latency).toBeLessThan(200)
    },
    TEST_TIMEOUT
  )

  it(
    '(b) round-trips ask_orchestrator → agent_question → send_to_agent → answer',
    async () => {
      const harness = await makeHarness()
      const started = await harness.call('start_agent', { role: 'worker', task: 'mode:ask' })
      const agentId = String(started.agentId)

      const { events } = await collectUntil(harness, (all) =>
        all.some((event) => event.type === 'agent_question')
      )
      const question = events.find((event) => event.type === 'agent_question')!
      expect(question).toMatchObject({ agentId, question: 'which option should I take?' })

      // The overview must carry the id the orchestrator needs to answer.
      const snapshot = await harness.call('list_agents')
      expect((snapshot.agents as Array<Record<string, unknown>>)[0]).toMatchObject({
        pendingQuestionId: question.questionId,
        pendingQuestion: 'which option should I take?'
      })

      const answered = await harness.call('send_to_agent', {
        agentId,
        text: 'take option B',
        questionId: question.questionId
      })
      expect(answered).toMatchObject({ ok: true, delivered: 'answer' })

      expect(await harness.host.waitForLine(agentId, 'ANSWER:')).toBe('ANSWER:take option B')
    },
    TEST_TIMEOUT
  )

  it(
    '(c) resumes a timed-out question with its ticket — exactly one agent_question',
    async () => {
      // A 300 ms ask window forces the ticket path that the 60 s MCP request
      // timeout would otherwise only produce in a real run.
      const harness = await makeHarness({ askTimeoutMs: 300 })
      const started = await harness.call('start_agent', { role: 'worker', task: 'mode:ask-ticket' })
      const agentId = String(started.agentId)

      const ticketLine = await harness.host.waitForLine(agentId, 'TICKET:')
      const ticket = ticketLine.slice('TICKET:'.length)
      expect(ticket.length).toBeGreaterThan(0)

      const answered = await harness.call('send_to_agent', {
        agentId,
        text: 'resume answer',
        questionId: ticket
      })
      expect(answered).toMatchObject({ ok: true, delivered: 'answer' })

      expect(await harness.host.waitForLine(agentId, 'ANSWER:')).toBe('ANSWER:resume answer')
      await harness.host.processes.get(agentId)!.exited

      const questions = harness.events.all().filter((event) => event.type === 'agent_question')
      expect(questions).toHaveLength(1)
      expect(questions[0]).toMatchObject({ questionId: ticket })
      expect(harness.host.processes.get(agentId)!.lines.filter((l) => l.startsWith('ERROR:'))).toEqual([])
    },
    TEST_TIMEOUT
  )

  it(
    '(d) reports a process that dies without reporting as agent_exited confirmed:false',
    async () => {
      const harness = await makeHarness()
      const started = await harness.call('start_agent', { role: 'worker', task: 'mode:die' })
      const agentId = String(started.agentId)

      const { events } = await collectUntil(harness, (all) =>
        all.some((event) => event.type === 'agent_exited')
      )
      const exited = events.find((event) => event.type === 'agent_exited')!
      expect(exited).toMatchObject({ agentId, confirmed: false, exitCode: 1 })
      expect(events.some((event) => event.type === 'agent_done')).toBe(false)

      // The reaction the orchestrator prompt prescribes must actually work.
      expect((await harness.call('read_output', { agentId, lines: 10 })).__isError).toBe(false)
    },
    TEST_TIMEOUT
  )

  it(
    '(e) loses nothing and duplicates nothing across consecutive await_events calls',
    async () => {
      const harness = await makeHarness()
      await harness.call('start_agent', { role: 'worker', task: 'mode:progress-then-done' })

      const { events, cursor } = await collectUntil(harness, (all) =>
        all.some((event) => event.type === 'agent_exited')
      )

      const seqs = events.map((event) => event.seq)
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
      expect(new Set(seqs).size).toBe(seqs.length)
      expect(seqs).toEqual(harness.events.all().map((event) => event.seq))
      expect(events.map((event) => event.type)).toEqual([
        'agent_started',
        'agent_progress',
        'agent_done',
        'agent_exited'
      ])
      // The agent reported before exiting, so this exit is confirmed — the
      // counterpart to (d).
      expect(events.at(-1)).toMatchObject({ confirmed: true, exitCode: 0 })

      // Re-reading with the returned cursor yields nothing and moves nothing.
      const again = await awaitEvents(harness, cursor, 1)
      expect(again.events).toEqual([])
      expect(again.cursor).toBe(cursor)
      expect(String(again.note)).toMatch(/call await_events again/i)
    },
    TEST_TIMEOUT
  )

  it(
    '(f) refuses to exceed a role slot limit and says by how much',
    async () => {
      const harness = await makeHarness({ perRole: { worker: 1 } })
      const first = await harness.call('start_agent', { role: 'worker', task: 'mode:ask' })
      expect(first.__isError).toBe(false)

      const second = await harness.call('start_agent', { role: 'worker', task: 'mode:ask' })
      expect(second.__isError).toBe(true)
      expect(second).toMatchObject({
        error: 'limit_exceeded',
        scope: 'role',
        role: 'worker',
        running: 1,
        max: 1
      })

      // Another role is still free, and stopping frees the worker slot again.
      const reviewer = await harness.call('start_agent', { role: 'reviewer', task: 'mode:ask' })
      expect(reviewer.__isError).toBe(false)

      const stopped = await harness.call('stop_agent', { agentId: String(first.agentId) })
      expect(stopped.ok).toBe(true)
      const third = await harness.call('start_agent', { role: 'worker', task: 'mode:ask' })
      expect(third.__isError).toBe(false)
    },
    TEST_TIMEOUT
  )

  it(
    'refuses an MCP URL for a workspace that is not registered',
    async () => {
      const harness = await makeHarness()
      const url = buildSubagentUrl(harness.handle.port, 'ws-does-not-exist', 'a1', 'guessed')
      const intruder = new Client({ name: 'intruder', version: '1.0.0' })
      await expect(
        intruder.connect(new StreamableHTTPClientTransport(new URL(url)))
      ).rejects.toMatchObject({ code: 401 })
    },
    TEST_TIMEOUT
  )
})
