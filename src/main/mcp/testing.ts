/**
 * Test-only helpers for the MCP layer. Nothing in `src/main` imports this at
 * runtime — it exists so the tool tests can call a tool exactly the way the MCP
 * SDK would (schema validation included) without an HTTP round trip.
 */
import { z, type ZodRawShape } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { createTaskBoard, type TaskBoard } from '@main/workspace/taskBoard'
import { EventQueue } from './eventQueue'
import { PendingQuestions } from './pendingQuestions'
import type {
  AgentHost,
  AgentSummary,
  InspectAgentOptions,
  InspectAgentResult,
  RunPullRequest,
  StartAgentInput,
  StartLeadInput,
  StartingAgent,
  StartingSuccession,
  ToolText,
  WorktreeFacts,
  WorkspaceMcpContext,
  WorkspaceRetroPort,
  WorkspaceRuntime
} from './types'
import type { SuccessionRequest } from '@shared/schema/handoff'
import type { AgentDoneStatus } from '@shared/schema/events'

export interface CapturedTool {
  name: string
  description?: string
  inputSchema: ZodRawShape
  handler: (args: Record<string, unknown>) => Promise<ToolText>
}

/** Run a `register*Tools` function against a recorder instead of a real server. */
export function captureTools(register: (server: McpServer) => void): Map<string, CapturedTool> {
  const tools = new Map<string, CapturedTool>()
  const recorder = {
    registerTool(
      name: string,
      config: { description?: string; inputSchema?: ZodRawShape },
      handler: (args: Record<string, unknown>) => Promise<ToolText>
    ) {
      tools.set(name, {
        name,
        description: config.description,
        inputSchema: config.inputSchema ?? {},
        handler
      })
      return undefined
    }
  }
  register(recorder as unknown as McpServer)
  return tools
}

/** Call a captured tool through its own schema, like the SDK does. */
export async function callTool(
  tools: Map<string, CapturedTool>,
  name: string,
  args: Record<string, unknown> = {}
): Promise<{ isError: boolean; text: string; json: Record<string, unknown> }> {
  const tool = tools.get(name)
  if (!tool) throw new Error(`Tool not registered: ${name}`)
  const parsed = z.object(tool.inputSchema).parse(args)
  const result = await tool.handler(parsed as Record<string, unknown>)
  const text = result.content.map((part) => part.text).join('')
  let json: Record<string, unknown> = {}
  try {
    const candidate: unknown = JSON.parse(text)
    if (candidate && typeof candidate === 'object') json = candidate as Record<string, unknown>
  } catch {
    json = {}
  }
  return { isError: result.isError === true, text, json }
}

export interface FakeHostOptions {
  /** Called instead of the default bookkeeping when an agent is started. */
  onStart?: (input: StartAgentInput, agent: AgentSummary) => void
  startError?: string
  /**
   * When set, every begun agent's `ready` REJECTS with this message — the
   * pipeline-failure path (`agent_start_failed`) becomes testable.
   */
  readyError?: string
  /** Override {@link AgentHost.reportingMode}; defaults to always `'mcp'`. */
  reportingMode?: (role: string) => AgentSummary['reporting']
  /** When set, {@link FakeAgentHost.snapshotWorktree} throws this message. */
  snapshotError?: string
  /**
   * Keep {@link FakeAgentHost.successionInProgress} true after
   * `requestSuccession` until {@link FakeAgentHost.completeSuccession} — used
   * to test the mutating-tool fence.
   */
  holdSuccession?: boolean
  successionError?: string
}

const FAKE_HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

/** An in-memory {@link AgentHost}: no processes, no windows, full bookkeeping. */
export class FakeAgentHost implements AgentHost {
  readonly agents = new Map<string, AgentSummary>()
  readonly sent: Array<{ agentId: string; text: string }> = []
  readonly seeded: Array<{ agentId: string; task: string }> = []
  readonly successionCalls: SuccessionRequest[] = []
  output = new Map<string, string>()
  /** Canned git facts per agent; absent → a clean fake snapshot. */
  snapshots = new Map<string, WorktreeFacts>()
  /** Canned raised ask windows per agent (ms); absent → classic 50 s default. */
  askWindows = new Map<string, number>()
  /** Live root id the fake succession reports as predecessor. */
  orchestratorId = 'orch-live'
  /** A3: every `adoptOnDone` the tool layer made — the adoption hook. */
  readonly adopted: Array<{ agentId: string; status: AgentDoneStatus }> = []
  /** A3: what the auto-PR hook answers with; undefined = the profile asked for none. */
  pullRequest: RunPullRequest | undefined
  readonly pullRequestCalls: Array<{ summary?: string }> = []
  /** A3: set to make the auto-PR hook throw — the retro must survive it. */
  pullRequestError: string | undefined
  private counter = 0
  private hostBoard: TaskBoard | undefined
  private successionHeld = false
  private successionResolvers: Array<(agent: import('./types').StartedAgent) => void> = []

  constructor(private readonly options: FakeHostOptions = {}) {}

  reportingMode(role: string): AgentSummary['reporting'] {
    return this.options.reportingMode?.(role) ?? 'mcp'
  }

  async adoptOnDone(agentId: string, status: AgentDoneStatus): Promise<void> {
    this.adopted.push({ agentId, status })
  }

  async openRunPullRequest(options: { summary?: string } = {}): Promise<RunPullRequest | undefined> {
    this.pullRequestCalls.push(options)
    if (this.pullRequestError) throw new Error(this.pullRequestError)
    return this.pullRequest
  }

  askTimeoutMsFor(agentId: string): number | undefined {
    return this.askWindows.get(agentId)
  }

  beginAgent(input: StartAgentInput): StartingAgent {
    // A sync throw mirrors the real host: reservation-stage refusals (no
    // slot, disabled provider) happen before anything is awaited.
    if (this.options.startError) throw new Error(this.options.startError)
    const agentId = `agent-${++this.counter}`
    // Every agent gets its own worktree and branch — the fake mirrors the invariant.
    const worktreePath = `/tmp/worktrees/${agentId}`
    const branch = `vertragus/arsenale/${agentId}`
    const agent: AgentSummary = {
      agentId,
      name: `Agent ${this.counter}`,
      role: input.role,
      status: 'running',
      model: input.model,
      worktreePath,
      branch,
      lastOutputAgeSec: 0,
      reporting: this.reportingMode(input.role)
    }
    this.agents.set(agentId, agent)
    this.seeded.push({ agentId, task: input.task })
    this.options.onStart?.(input, agent)
    return {
      agentId,
      name: agent.name,
      role: agent.role,
      providerId: 'fake',
      model: input.model,
      worktreePath,
      branch,
      // The fake has no pipeline — a begun agent is a ready agent (unless the
      // test injected a pipeline failure via `readyError`).
      ready: this.options.readyError
        ? Promise.reject(new Error(this.options.readyError))
        : Promise.resolve()
    }
  }

  async sendToAgent(agentId: string, text: string): Promise<void> {
    if (!this.agents.has(agentId)) throw new Error(`Unknown agent ${agentId}`)
    this.sent.push({ agentId, text })
  }

  async stopAgent(agentId: string): Promise<boolean> {
    const agent = this.agents.get(agentId)
    if (!agent || agent.status === 'stopped') return false
    this.agents.set(agentId, { ...agent, status: 'stopped' })
    return true
  }

  async readOutput(agentId: string, lines: number): Promise<string> {
    if (!this.agents.has(agentId)) throw new Error(`Unknown agent ${agentId}`)
    const all = (this.output.get(agentId) ?? '').split('\n')
    return all.slice(Math.max(0, all.length - lines)).join('\n')
  }

  /** S1: the whole canned buffer — the fake's "no line cap". */
  async readOutputFull(agentId: string): Promise<string> {
    if (!this.agents.has(agentId)) throw new Error(`Unknown agent ${agentId}`)
    return this.output.get(agentId) ?? ''
  }

  /** S1: canned inspect body per agent; absent → the small fake body. */
  inspectBodies = new Map<string, string>()

  async inspectAgent(agentId: string, options: InspectAgentOptions): Promise<InspectAgentResult> {
    const facts = await this.snapshotWorktree(agentId)
    if (options.view === 'file' && !options.path?.trim()) {
      throw new Error('inspect view "file" needs path.')
    }
    const extra = options.path ? ` ${options.path}` : ''
    const body = this.inspectBodies.get(agentId) ?? `(fake ${options.view}${extra})`
    return { ...facts, view: options.view, body }
  }

  async snapshotWorktree(agentId: string): Promise<WorktreeFacts> {
    const agent = this.agents.get(agentId)
    if (!agent) throw new Error(`Unknown agent ${agentId}`)
    if (agent.status === 'starting') {
      throw new Error(`${agent.name} is still starting — wait for its agent_started event.`)
    }
    if (this.options.snapshotError) throw new Error(this.options.snapshotError)
    return (
      this.snapshots.get(agentId) ?? {
        branch: agent.branch ?? 'unknown',
        headSha: FAKE_HEAD,
        uncommitted: false,
        changedFiles: [],
        diffStat: ''
      }
    )
  }

  /** Every C3 done-snapshot the tools asked for, in call order. */
  readonly doneSnapshots: Array<{ agentId: string; summary: string }> = []

  /** E1: recorded merges; set `integrateConflict` to force the conflict path. */
  readonly integrations: Array<{ agentId: string; branch: string }> = []
  integrateConflict: { conflictFiles: string[]; message: string } | undefined

  async integrateBranch(agentId: string, branch: string): ReturnType<AgentHost['integrateBranch']> {
    if (!this.agents.has(agentId)) throw new Error(`Unknown agent ${agentId}`)
    this.integrations.push({ agentId, branch })
    if (this.integrateConflict) return { ok: false, ...this.integrateConflict }
    return { ok: true, headSha: FAKE_HEAD }
  }

  /** E4: settable wall clock; no limit by default. */
  budgetState: ReturnType<AgentHost['budget']> = { usedSec: 0, exhausted: false }

  budget(): ReturnType<AgentHost['budget']> {
    return this.budgetState
  }

  async snapshotDone(agentId: string, summary: string): Promise<WorktreeFacts> {
    const facts = await this.snapshotWorktree(agentId)
    this.doneSnapshots.push({ agentId, summary })
    // Mirror the real host: a dirty worktree comes back committed, keeping
    // the pre-commit change set on the facts.
    if (!facts.uncommitted) return facts
    return { ...facts, uncommitted: false, headSha: `${facts.headSha.slice(0, 39)}b` }
  }

  listAgents(): AgentSummary[] {
    return [...this.agents.values()]
  }

  /** F: leads mirror beginAgent, with the lead role and no profile slot. */
  beginLead(input: StartLeadInput): StartingAgent {
    if (this.options.startError) throw new Error(this.options.startError)
    const agentId = `agent-${++this.counter}`
    const worktreePath = `/tmp/worktrees/${agentId}`
    const branch = `vertragus/arsenale/${agentId}`
    const agent: AgentSummary = {
      agentId,
      name: `Lead ${this.counter}`,
      role: 'lead',
      status: 'running',
      model: input.model,
      worktreePath,
      branch,
      lastOutputAgeSec: 0,
      kind: 'lead',
      reporting: 'mcp'
    }
    this.agents.set(agentId, agent)
    this.seeded.push({ agentId, task: input.task })
    return {
      agentId,
      name: agent.name,
      role: agent.role,
      providerId: 'fake',
      model: input.model,
      worktreePath,
      branch,
      ready: Promise.resolve()
    }
  }

  successionInProgress(): boolean {
    return this.successionHeld
  }

  /**
   * S4 × C6: the host half of the single board seam, mirroring
   * `Workspace.attachTaskBoard` — including its refusal of a second, different
   * board, which is the wiring bug the seam exists to make loud.
   */
  attachedTaskBoard(): TaskBoard | undefined {
    return this.hostBoard
  }

  attachTaskBoard(board: TaskBoard): void {
    if (this.hostBoard && this.hostBoard !== board) {
      throw new Error('Fake host already has a different task board attached.')
    }
    this.hostBoard = board
  }

  requestSuccession(input: SuccessionRequest): StartingSuccession {
    if (this.successionHeld) throw new Error('already_in_progress')
    if (this.options.successionError) throw new Error(this.options.successionError)
    this.successionCalls.push(input)
    this.successionHeld = true
    const successorAgentId = `orch-${++this.counter}`
    const successorName = `Guide ${this.counter}`
    const started = {
      agentId: successorAgentId,
      name: successorName,
      role: 'orchestrator',
      providerId: 'fake',
      worktreePath: `/tmp/worktrees/${successorAgentId}`,
      branch: `vertragus/arsenale/${successorAgentId}`
    }
    const ready = this.options.holdSuccession
      ? new Promise<typeof started>((resolve) => {
          this.successionResolvers.push(resolve)
        })
      : Promise.resolve(started).then((agent) => {
          this.successionHeld = false
          return agent
        })
    return {
      successorAgentId,
      successorName,
      predecessorAgentId: this.orchestratorId,
      eventCursor: 0,
      ready
    }
  }

  /** Unblock a held succession (tests that asserted the fence). */
  completeSuccession(): void {
    this.successionHeld = false
    const started = {
      agentId: `orch-${this.counter}`,
      name: `Guide ${this.counter}`,
      role: 'orchestrator',
      providerId: 'fake',
      worktreePath: `/tmp/worktrees/orch-${this.counter}`,
      branch: `vertragus/arsenale/orch-${this.counter}`
    }
    for (const resolve of this.successionResolvers) resolve(started)
    this.successionResolvers = []
  }
}

export interface FakeRuntimeOptions {
  roles?: string[]
  perRole?: Record<string, number | undefined>
  maxTotal?: number
  askTimeoutMs?: number
  /** Injected long-poll window — tests use seconds small enough to actually wait. */
  awaitTimeout?: { defaultSec: number; maxSec: number }
  host?: FakeAgentHost
  retro?: WorkspaceRetroPort
  /** S1: injected spill store; absent keeps today's inline behaviour. */
  spill?: WorkspaceMcpContext['spill']
  /** S4: override the default in-memory board; `null` = a runtime WITHOUT one. */
  taskBoard?: TaskBoard | null
}

/** S4: a task board that never touches disk — persistence is stubbed out. */
export function memoryTaskBoard(now?: () => number): TaskBoard {
  return createTaskBoard('/repo', 'ws-test', {
    mkdir: async () => undefined,
    writeFile: async () => undefined,
    rename: async () => undefined,
    ...(now ? { now } : {})
  })
}

/** A workspace runtime wired to a {@link FakeAgentHost}. */
export function fakeRuntime(options: FakeRuntimeOptions = {}): WorkspaceRuntime & {
  host: FakeAgentHost
  events: EventQueue
} {
  const host = options.host ?? new FakeAgentHost()
  const events = new EventQueue()
  const ctx: WorkspaceMcpContext = {
    workspaceId: 'ws-test',
    workspaceName: 'Arsenale',
    repoPath: '/repo',
    orchToken: 'orch-token',
    subToken: 'sub-token',
    host,
    events,
    limits: {
      perRole: new Map(Object.entries(options.perRole ?? {})),
      maxTotal: options.maxTotal
    },
    roles: options.roles ?? ['worker', 'reviewer'],
    askTimeoutMs: options.askTimeoutMs,
    awaitTimeout: options.awaitTimeout,
    retro: options.retro,
    spill: options.spill
  }
  const taskBoard = options.taskBoard === null ? undefined : options.taskBoard ?? memoryTaskBoard()
  return {
    ctx,
    questions: new PendingQuestions(),
    agentTasks: new Map(),
    leads: new Map(),
    nests: new Map(),
    parentOf: new Map(),
    resultSchemas: new Map(),
    ...(taskBoard ? { taskBoard } : {}),
    host,
    events
  }
}
