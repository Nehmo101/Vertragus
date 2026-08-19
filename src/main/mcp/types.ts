/**
 * The contract between the MCP layer and the rest of the app.
 *
 * The MCP layer knows nothing about PTYs, windows, worktrees or providers. It
 * talks to an {@link AgentHost} — implemented by the WorkspaceManager — and to
 * an {@link EventQueue}. That keeps the whole orchestration loop testable with
 * a fake host and no Electron in sight.
 *
 * ## Who pushes which event
 * One owner per channel, no duplicates. The MCP layer pushes `agent_started`
 * (once a begun agent's `ready` resolves), `agent_start_failed` (when it
 * rejects), `agent_stopped` (after a successful `stopAgent`), and — for agents
 * that talk to Vertragus over MCP — `agent_done` / `agent_question` /
 * `agent_progress` from the subagent tools. The host pushes `agent_exited` and
 * `orchestrator_exited` (only it can observe a process dying unasked) and, for
 * `mcp: none` (sentinel) providers, `agent_done` / `agent_progress` parsed
 * from PTY sentinel lines — for those agents the host *is* the reporting
 * channel (and attaches worktree facts to sentinel `agent_done` when git
 * answers). A host must NOT duplicate MCP-tool events for an MCP-attached
 * agent, and the MCP tools must not invent PTY-sentinel events.
 */
import type { EventQueue } from './eventQueue'
import type { PendingQuestions } from './pendingQuestions'
import type { ReportingMode } from '@shared/prompts/contract'
import type { SuccessionRequest } from '@shared/schema/handoff'

/** What `start_agent` hands the host. */
export interface StartAgentInput {
  role: string
  /** Full seed text — task plus the appended contract. */
  task: string
  model?: string
  /**
   * Existing branch the agent's own branch starts from — how one agent builds
   * on another's result. Absent = the repository HEAD.
   */
  baseBranch?: string
}

/** What the host reports back once the agent process is up and seeded. */
export interface StartedAgent {
  agentId: string
  name: string
  role: string
  /** Effective provider the agent runs on — resolved from the slot. */
  providerId: string
  /** Resolved model; absent = the provider CLI's own default. */
  model?: string
  /** Every agent works in its own git worktree — this is where. */
  worktreePath: string
  /** The agent's own branch — pass it as another agent's `baseBranch` to chain work. */
  branch: string
}

/** One row of `list_agents` / the `agentsSummary` in `await_events`. */
export interface AgentSummary {
  agentId: string
  name: string
  role: string
  status: string
  model?: string
  worktreePath?: string
  /** The agent's own branch, for `baseBranch` chaining and merge tasks. */
  branch?: string
  /** Seconds since the agent's PTY last produced output. */
  lastOutputAgeSec: number
  /** Text of the agent's currently unanswered question, when it has one. */
  pendingQuestion?: string
  /**
   * How this agent reports back. Drives the contract/reminder dialect on
   * follow-ups (`send_to_agent`). Derived from the provider's `mcp.kind`.
   */
  reporting: ReportingMode
}

/**
 * A begun agent: identity now, readiness later.
 *
 * `beginAgent` returns this before the process even exists — id, name,
 * worktree and branch are all decided synchronously. `ready` settles when the
 * pipeline behind it (worktree, spawn, seed handshake) finishes.
 */
export interface StartingAgent extends StartedAgent {
  /**
   * Resolves once the CLI accepted its task; rejects when any stage failed
   * (the reservation is released then). `start_agent` deliberately does NOT
   * await this — the full pipeline can outlast the 60 s MCP request timeout —
   * and instead turns the outcome into `agent_started` / `agent_start_failed`
   * events the orchestrator reads via `await_events`.
   */
  ready: Promise<void>
}

/**
 * A begun orchestrator succession: successor identity now, cutover later.
 *
 * `requestSuccession` returns this before the successor process exists.
 * `ready` settles when the successor has been seeded (or rejects if spawn
 * failed and the predecessor was restored).
 */
export interface StartingSuccession {
  successorAgentId: string
  successorName: string
  predecessorAgentId: string
  eventCursor: number
  ready: Promise<StartedAgent>
}

/** Read-only views `inspect_agent` can ask of one agent's worktree. */
export const INSPECT_VIEWS = ['status', 'diff', 'log', 'file'] as const
export type InspectView = (typeof INSPECT_VIEWS)[number]

/**
 * Host-truth git facts for one worktree. No porcelain blob — that stays inside
 * the `status` view body. Attached to `agent_done` and returned by
 * {@link AgentHost.snapshotWorktree}.
 */
export interface WorktreeFacts {
  branch: string
  headSha: string
  uncommitted: boolean
  changedFiles: string[]
  diffStat: string
}

export interface InspectAgentOptions {
  view: InspectView
  /** Relative path inside the worktree — required for `file`. */
  path?: string
  /** Line count for `log`; ignored otherwise. */
  lines?: number
}

export interface InspectAgentResult extends WorktreeFacts {
  view: InspectView
  body: string
}

/** Fields copied onto `agent_done` when a worktree snapshot succeeds. */
export function worktreeEventFields(facts: WorktreeFacts): WorktreeFacts {
  return {
    branch: facts.branch,
    headSha: facts.headSha,
    uncommitted: facts.uncommitted,
    changedFiles: facts.changedFiles,
    diffStat: facts.diffStat
  }
}

/**
 * Everything the MCP tools need from the process/window world. Implemented by
 * the WorkspaceManager; faked wholesale in tests.
 */
export interface AgentHost {
  /**
   * Reserve and begin one agent start. Synchronous up to the reservation: when
   * this returns, the agent already occupies its slot and shows up in
   * {@link listAgents} as `starting` — which is what makes the limit checks in
   * `start_agent` race-free (two concurrent calls cannot both pass a cap of
   * one, because check and reservation happen in one synchronous block). The
   * heavy lifting continues behind {@link StartingAgent.ready}.
   */
  beginAgent(input: StartAgentInput): StartingAgent
  /** Type text into the agent's PTY. */
  sendToAgent(agentId: string, text: string): Promise<void>
  /** Kill the agent; `false` when there was nothing (left) to kill. */
  stopAgent(agentId: string): Promise<boolean>
  /** ANSI-stripped tail of the agent's output. */
  readOutput(agentId: string, lines: number): Promise<string>
  /**
   * Read-only git inspection of one agent's own worktree. Refuses agents that
   * are still `starting`. Stopped agents remain inspectable — their worktree
   * survives `stop_agent`.
   */
  inspectAgent(agentId: string, options: InspectAgentOptions): Promise<InspectAgentResult>
  /**
   * A compact snapshot of one agent's worktree (branch, HEAD, dirty flag,
   * changed files, diffstat). Same refusal rules as {@link inspectAgent}.
   * Callers that attach this to `agent_done` must tolerate a throw: a git
   * hiccup must never drop the done event.
   */
  snapshotWorktree(agentId: string): Promise<WorktreeFacts>
  listAgents(): AgentSummary[]
  /**
   * True while a root succession is in flight. Mutating orchestrator tools
   * refuse with `succession_in_progress` until the successor is active.
   */
  successionInProgress(): boolean
  /**
   * Replace the live root orchestrator with a successor that continues the
   * same run. Synchronous reservation (fence + package + event); the spawn
   * pipeline continues behind {@link StartingSuccession.ready}.
   */
  requestSuccession(input: SuccessionRequest): StartingSuccession
  /**
   * Which reporting dialect a *new* agent of this role should get. Used by
   * `start_agent` before the agent exists; derived from the profile slot's
   * provider (`mcp.kind === 'none'` → sentinel).
   */
  reportingMode(role: string): ReportingMode
}

/** How many agents the orchestrator may run. */
export interface WorkspaceLimits {
  /**
   * Per-role cap. An entry with `undefined` means "role allowed, no cap";
   * a missing entry means the same (roles are gated by {@link WorkspaceMcpContext.roles}).
   */
  perRole: Map<string, number | undefined>
  /** Cap across all roles (profile-level `maxSubagents`); absent = free choice. */
  maxTotal?: number
}

/** One workspace as the MCP server sees it. */
export interface WorkspaceMcpContext {
  workspaceId: string
  workspaceName: string
  repoPath: string
  /** Secret in the orchestrator's MCP URL. */
  orchToken: string
  /** Secret in every subagent's MCP URL. */
  subToken: string
  host: AgentHost
  events: EventQueue
  limits: WorkspaceLimits
  /** Role ids the orchestrator may pass to `start_agent`. */
  roles: string[]
  /**
   * How long `ask_orchestrator` blocks before handing out a ticket. Defaults to
   * 50 s (below the 60 s MCP request timeout). Tests shorten it.
   */
  askTimeoutMs?: number
  /**
   * Where `record_retro` lands. Absent = the tool answers `retro_unavailable`
   * instead of failing the workspace — retros are an amenity, never a blocker.
   */
  retro?: WorkspaceRetroPort
}

/** One qualitative insight as the orchestrator hands it in — role-keyed. */
export interface RetroLearningInput {
  role: string
  /** Overrides the slot's model, e.g. when start_agent used a model override. */
  model?: string
  kind: 'strength' | 'weakness'
  insight: string
  evidence?: string
}

/** The main-process sink behind `record_retro`; resolves roles to providers. */
export interface WorkspaceRetroPort {
  recordLearnings(learnings: readonly RetroLearningInput[]): { applied: number }
  recordSummary(summary: string): void
}

/** A registered workspace: its context plus the state the MCP layer owns. */
export interface WorkspaceRuntime {
  ctx: WorkspaceMcpContext
  questions: PendingQuestions
  /**
   * The latest assignment the orchestrator handed out, shortened via
   * {@link taskNote}. The panel shows it in the workspace tooltip — it lives
   * here because only the MCP layer sees the raw task before the contract is
   * appended.
   */
  latestTask?: string
  /**
   * Current assignment per subagent, shortened via {@link taskNote}. Written by
   * `start_agent` and follow-up `send_to_agent` calls (never by question
   * answers), read by the panel's agent rows and the CLI windows' hover cards.
   * Entries outlive a stopped agent on purpose — "what was it working on?" is
   * exactly the question a hover over a finished agent answers.
   */
  agentTasks: Map<string, string>
  /**
   * Fires after {@link latestTask} / {@link agentTasks} changed. The
   * WorkspaceManager binds this to its change feed so the panel and the CLI
   * windows follow a follow-up assignment live — a follow-up pushes no agent
   * event, so without this hook nothing would wake the UI.
   */
  onTasksChanged?: () => void
}

/** Max length of the panel's "current task" note. */
export const TASK_NOTE_MAX = 140

/**
 * Shorten an assignment to its first non-empty line for the workspace tooltip.
 * Undefined for whitespace-only text — a blank note must not overwrite a
 * meaningful one.
 */
export function taskNote(task: string): string | undefined {
  const line = task
    .split('\n')
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0)
  if (!line) return undefined
  return line.length <= TASK_NOTE_MAX ? line : `${line.slice(0, TASK_NOTE_MAX - 1)}…`
}

/**
 * Record one handed-out assignment: the agent's own current task and the
 * workspace's latest one, in one step, with one notification. A whitespace-only
 * text records nothing — a blank note must not overwrite a meaningful one.
 */
export function recordAssignment(runtime: WorkspaceRuntime, agentId: string, task: string): void {
  const note = taskNote(task)
  if (!note) return
  runtime.agentTasks.set(agentId, note)
  runtime.latestTask = note
  runtime.onTasksChanged?.()
}

/** Statuses that mean "this agent no longer occupies a slot". */
export const TERMINAL_AGENT_STATUSES = new Set(['exited', 'stopped', 'failed', 'dead'])

/** Agents that still occupy a slot for limit accounting. */
export function runningAgents(agents: readonly AgentSummary[]): AgentSummary[] {
  return agents.filter((agent) => !TERMINAL_AGENT_STATUSES.has(agent.status))
}

/** One row of the agent overview the orchestrator tools return. */
export interface AgentsSummaryRow extends AgentSummary {
  /** Pass this to `send_to_agent` to answer {@link AgentSummary.pendingQuestion}. */
  pendingQuestionId?: string
}

/**
 * The agent overview, enriched with the open questions the MCP layer knows
 * about — the host cannot see them, and without the id the orchestrator has no
 * way to answer.
 */
export function summarizeAgents(runtime: WorkspaceRuntime): AgentsSummaryRow[] {
  return runtime.ctx.host.listAgents().map((agent) => {
    const open = runtime.questions.openForAgent(agent.agentId)
    if (!open) return { ...agent }
    return { ...agent, pendingQuestion: open.question, pendingQuestionId: open.questionId }
  })
}

/**
 * MCP tool result shape (text content only — every tool answers with JSON).
 * The index signature is what the SDK's `CallToolResult` requires.
 */
export interface ToolText {
  [key: string]: unknown
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

export function toolText(body: string): ToolText {
  return { content: [{ type: 'text', text: body }] }
}

export function toolJson(body: unknown): ToolText {
  return toolText(JSON.stringify(body, null, 2))
}

/** A tool-level failure: the model sees it as an error, the call still returns. */
export function toolError(body: Record<string, unknown>): ToolText {
  return { ...toolJson(body), isError: true }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
