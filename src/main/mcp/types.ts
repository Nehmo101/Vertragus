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
import type { AgentPolicy } from '@shared/agentPolicy'
import type { ReportingMode } from '@shared/prompts/contract'
import type { SuccessionRequest } from '@shared/schema/handoff'
// Type-only on purpose: the MCP layer stays free of workspace runtime code —
// the store implementation is injected by the host via the context.
import type { SpillStore } from '@main/workspace/spill'
import type { ResultSchema } from '@shared/schema/resultSchema'
import type { TaskBoard } from '@main/workspace/taskBoard'

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
  /**
   * Track 4: pick a SPECIFIC profile slot of the role instead of the first
   * one with capacity. An unknown id or a full slot is a hard error — an
   * explicit choice must never silently land elsewhere.
   */
  slotId?: string
  /**
   * Track 4: pick the role's slot running THIS provider (e.g. "codex").
   * Without it `slotWithCapacity` keeps choosing "first with room", which in
   * practice always favours the first provider. Ignored when `slotId` is set
   * (they must agree then).
   */
  providerId?: string
}

/**
 * F: what `start_orchestrator` hands the host. A lead is NOT a profile slot —
 * it runs the profile's orchestrator provider (overridable model), gets an
 * orchestrator-kind name, never yolo, and its own worktree/branch like every
 * agent.
 */
export interface StartLeadInput {
  /** Short label for prompt and panel ("payments", "docs"). */
  area: string
  /** Full seed text — task plus the appended contract. */
  task: string
  model?: string
  baseBranch?: string
  /** Subtree budget the root handed down — rendered into the lead prompt. */
  maxSubagents?: number
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

/** One row of the host's agent overview — `list_agents` returns it in full. */
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
  /** F: set for sub-orchestrators started via `start_orchestrator`. */
  kind?: 'lead'
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
  /**
   * Relative path inside the worktree — required for `file`, optional for
   * `diff` (narrows the diff to that path).
   */
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
  /**
   * F: reserve and begin one LEAD start — same synchronous-reservation rules
   * as {@link beginAgent}. The lead runs the profile's orchestrator provider,
   * gets a lead system prompt for its `area`, no yolo, and a `lead=` MCP URL.
   */
  beginLead(input: StartLeadInput): StartingAgent
  /** Type text into the agent's PTY. */
  sendToAgent(agentId: string, text: string): Promise<void>
  /** Kill the agent; `false` when there was nothing (left) to kill. */
  stopAgent(agentId: string): Promise<boolean>
  /** ANSI-stripped tail of the agent's output. */
  readOutput(agentId: string, lines: number): Promise<string>
  /**
   * S1: the WHOLE retained scrollback, same normalisation and source as
   * {@link readOutput} but without the line cap. Only `read_output{full:true}`
   * calls it, and the tool spills the result to a file instead of inlining it.
   */
  readOutputFull(agentId: string): Promise<string>
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
  /**
   * C3: the done-time snapshot. A dirty worktree is COMMITTED onto the
   * agent's own branch first (message `vertragus: <agent> / <role> — <first
   * summary line>`; no push, no --force), so `baseBranch` chaining points at
   * the work instead of at HEAD. The returned facts keep the pre-commit
   * `changedFiles`/`diffStat` — they describe what this done changed — while
   * `headSha`/`uncommitted` reflect the post-commit state. A failed commit
   * falls back to the plain dirty snapshot; callers must tolerate a throw
   * exactly like {@link snapshotWorktree} (never drop the done event).
   */
  snapshotDone(agentId: string, summary: string): Promise<WorktreeFacts>
  /**
   * E1: merge `branch` into the agent's own worktree — the host-side
   * integrate. No push, no --force; a conflict aborts (worktree stays clean)
   * and reports the files. Same refusal rules as {@link inspectAgent}.
   */
  integrateBranch(agentId: string, branch: string): Promise<IntegrateOutcome>
  /**
   * E4: the workspace's runtime budget — a wall clock over agent-seconds,
   * never a guessed token counter. `limitSec` absent = no budget configured.
   */
  budget(): WorkspaceBudget
  listAgents(): AgentSummary[]
  /**
   * The raised `ask_orchestrator` block window for THIS agent, in
   * milliseconds, already margin-adjusted below its own CLI's MCP tool
   * timeout — the same derivation that funds the orchestrator's long
   * `await_events` poll. Undefined (or an absent method — old fakes) keeps
   * the classic 50 s window. Per agent, not per workspace: a codex worker on
   * a 60 s CLI timeout must keep ticketing even while a claude worker in the
   * same run blocks for minutes, so the workspace-wide `askTimeoutMs` could
   * never carry this.
   */
  askTimeoutMsFor?(agentId: string): number | undefined
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

/** E1: outcome of a host merge into an agent worktree. */
export type IntegrateOutcome =
  | { ok: true; headSha: string }
  | { ok: false; conflictFiles: string[]; message: string }

/** E4: the workspace's wall-clock budget state. */
export interface WorkspaceBudget {
  /** Sum of agent-seconds so far (running agents count up to now). */
  usedSec: number
  /** From the profile's `maxRuntimeMin`; absent = unbounded. */
  limitSec?: number
  /** True once the budget is spent — new starts must be refused. */
  exhausted: boolean
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
   * D4: the tier subagents run under. `ask-orchestrator` makes `start_agent`
   * append the approval rule to every task contract; the other tiers (and an
   * old fake that omits the field) leave the contract untouched — their
   * enforcement is the CLI's permission layer, not the prompt.
   */
  agentPolicy?: AgentPolicy
  /**
   * How long `ask_orchestrator` blocks before handing out a ticket. Defaults to
   * 50 s (below the 60 s MCP request timeout). Tests shorten it.
   */
  askTimeoutMs?: number
  /**
   * Long-poll window for `await_events`. Set by the host when the
   * orchestrator's provider tolerates MCP tool calls longer than the default
   * 60 s (the attach layer raises the CLI's timeout); absent = the classic
   * 50 s default / 55 s max. Fewer, longer polls save orchestrator turns —
   * every empty wake-up costs a full model pass over the whole context.
   */
  awaitTimeout?: { defaultSec: number; maxSec: number }
  /**
   * Where `record_retro` lands. Absent = the tool answers `retro_unavailable`
   * instead of failing the workspace — retros are an amenity, never a blocker.
   */
  retro?: WorkspaceRetroPort
  /**
   * S1: where oversized tool output spills to disk (preview + path instead of
   * truncation). Optional like `retro` — absent (old fakes, unit tests) keeps
   * today's inline behaviour everywhere.
   */
  spill?: SpillStore
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
  /** E2: durable repo facts for future briefings; optional for old fakes. */
  recordRepoNotes?(notes: readonly string[]): { applied: number }
}

/**
 * E4: bookkeeping so budget thresholds fire exactly once per workspace —
 * lives on the runtime because the tool layer is the one that reads the
 * clock on every call.
 */
export interface BudgetFlags {
  warned: boolean
  exhausted: boolean
}

/** F: host-enforced cap on concurrent leads (the profile may be tighter). */
export const MAX_LEADS = 4

/** F: one running sub-orchestrator and the state the MCP layer keeps for it. */
export interface LeadRuntime {
  agentId: string
  /** Short label for prompt and panel ("payments", "docs"). */
  area: string
  /**
   * The lead's OWN event queue — its `await_events` reads here, and its
   * subtree's events land here instead of in the root queue. Fan-in is the
   * whole point: without it nesting just multiplies the root's event storm.
   */
  events: EventQueue
  /** Subtree budget the root handed down; undefined = only the global cap. */
  maxSubagents?: number
}

/** A registered workspace: its context plus the state the MCP layer owns. */
export interface WorkspaceRuntime {
  ctx: WorkspaceMcpContext
  questions: PendingQuestions
  /**
   * S4: the run's task board — the shared plan of root and leads, persisted
   * next to the run journal. Installed by the WorkspaceManager after
   * registration (like the journal, it needs the repository on disk); absent
   * in old fakes, where the task tools answer `task_board_unavailable`.
   */
  taskBoard?: TaskBoard
  /** F: running leads by agentId. Empty in a flat (default) run. */
  leads: Map<string, LeadRuntime>
  /**
   * F: which lead a subagent belongs to. No entry = direct child of the root.
   * Leads themselves have no entry (they ARE direct children).
   */
  parentOf: Map<string, string>
  /**
   * F: fires when `start_orchestrator` minted a new lead queue — the
   * WorkspaceManager taps it for the retro feed and the panel change feed
   * (subtree events bypass the root queue by design, so without this hook
   * neither would see them).
   */
  onLeadCreated?: (lead: LeadRuntime) => void
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
   * S3: the vetted `start_agent{resultSchema}` per agent — what `report_done`
   * validates `result` against before pushing `agent_done`. Entries are
   * removed on `agent_start_failed` and in `stop_agent`; a follow-up via
   * `send_to_agent` deliberately KEEPS the schema (v1: one schema per agent
   * life, documented in the tool).
   */
  resultSchemas: Map<string, ResultSchema>
  /**
   * Fires after {@link latestTask} / {@link agentTasks} changed. The
   * WorkspaceManager binds this to its change feed so the panel and the CLI
   * windows follow a follow-up assignment live — a follow-up pushes no agent
   * event, so without this hook nothing would wake the UI.
   */
  onTasksChanged?: () => void
  /**
   * C5: fires at the start AND end of every orchestrator tool call — the
   * host's idle watchdog feeds on it. End included on purpose: a parked
   * `await_events` long-poll (~50 s) touches when it returns, so a live loop
   * never looks idle even though no *new* call happened while it blocked.
   */
  onOrchestratorToolCall?: () => void
  /** E4: which budget thresholds were already announced. */
  budgetFlags?: BudgetFlags
}

/**
 * D3: registry key for questions the orchestrator asks the HUMAN (`ask_user`).
 * They live in the same {@link PendingQuestions} registry as agent questions —
 * one registry, one answer path (H1's `answerQuestion` with this agentId) —
 * but under an id no real agent can ever have, so `send_to_agent{questionId}`
 * cannot accidentally answer the user's question for them.
 */
export const USER_QUESTION_AGENT_ID = 'user'

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

/**
 * F: the queue an event ABOUT this agent belongs in — its parent's. A lead's
 * child routes to the lead queue, everything else (root children and the
 * leads themselves) to the root queue. A closed lead queue (adopted subtree)
 * falls back to the root, so a late event of a dying subtree is never lost.
 */
export function queueForAgent(runtime: WorkspaceRuntime, agentId: string): EventQueue {
  const parent = runtime.parentOf.get(agentId)
  if (parent) {
    const lead = runtime.leads.get(parent)
    if (lead && !lead.events.isClosed) return lead.events
  }
  return runtime.ctx.events
}

/**
 * F: a lead died or was stopped — reparent its still-tracked children to the
 * root and close the lead queue (releasing any parked reader). The root gets
 * ONE `subtree_adopted` event; past subtree events are not replayed (the
 * retro tap already saw them), the root inspects the adopted agents instead.
 */
export function adoptSubtree(runtime: WorkspaceRuntime, leadAgentId: string): void {
  const lead = runtime.leads.get(leadAgentId)
  if (!lead) return
  runtime.leads.delete(leadAgentId)
  const adopted: string[] = []
  for (const [child, parent] of [...runtime.parentOf]) {
    if (parent !== leadAgentId) continue
    runtime.parentOf.delete(child)
    adopted.push(child)
  }
  lead.events.close()
  if (!runtime.ctx.events.isClosed) {
    runtime.ctx.events.push({
      type: 'subtree_adopted',
      leadAgentId,
      area: lead.area,
      adoptedAgentIds: adopted
    })
  }
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
  /** F: how many children a lead currently has (lead rows in the root view). */
  childCount?: number
}

/** F: true when this agent is a direct child of the given caller scope. */
export function inScope(
  runtime: WorkspaceRuntime,
  agentId: string,
  leadId: string | undefined
): boolean {
  return runtime.parentOf.get(agentId) === leadId
}

/**
 * The FULL agent overview, enriched with the open questions the MCP layer knows
 * about — the host cannot see them, and without the id the orchestrator has no
 * way to answer. F: scoped to DIRECT children of the caller — the root sees
 * its own children (leads included, with their child counts), a lead sees only
 * its subtree; grandchildren never leak into the root's view.
 *
 * Only `list_agents` — the deliberate one-off overview — returns these rows.
 * `await_events` repeats its summary on every single loop turn, so it uses
 * {@link slimAgentsSummary} instead.
 */
export function summarizeAgents(
  runtime: WorkspaceRuntime,
  scope?: { leadId?: string }
): AgentsSummaryRow[] {
  const leadId = scope?.leadId
  return runtime.ctx.host
    .listAgents()
    .filter((agent) => inScope(runtime, agent.agentId, leadId))
    .map((agent) => {
      const open = runtime.questions.openForAgent(agent.agentId)
      const childCount = runtime.leads.has(agent.agentId)
        ? [...runtime.parentOf.values()].filter((parent) => parent === agent.agentId).length
        : undefined
      return {
        ...agent,
        ...(childCount !== undefined ? { childCount } : {}),
        ...(open ? { pendingQuestion: open.question, pendingQuestionId: open.questionId } : {})
      }
    })
}

/**
 * The row `await_events` returns: everything that CHANGES over an agent's life,
 * nothing that is fixed at birth.
 */
export type SlimAgentsSummaryRow = Omit<AgentsSummaryRow, 'worktreePath' | 'model' | 'reporting'>

/**
 * {@link summarizeAgents} minus the three static-per-agent fields
 * (`worktreePath`, `model`, `reporting`). They never change after the start, and
 * the orchestrator already got all three from `start_agent` and the
 * `agent_started` event — repeating them on every await_events turn is pure
 * token waste. `list_agents` still hands out the full row when the orchestrator
 * genuinely wants the overview again.
 */
export function slimAgentsSummary(
  runtime: WorkspaceRuntime,
  scope?: { leadId?: string }
): SlimAgentsSummaryRow[] {
  // Built by naming what stays rather than deleting what goes: a new field on
  // AgentSummary must then be opted INTO the per-turn payload, never sneak in.
  return summarizeAgents(runtime, scope).map((row) => ({
    agentId: row.agentId,
    name: row.name,
    role: row.role,
    status: row.status,
    ...(row.branch !== undefined ? { branch: row.branch } : {}),
    lastOutputAgeSec: row.lastOutputAgeSec,
    ...(row.kind !== undefined ? { kind: row.kind } : {}),
    ...(row.childCount !== undefined ? { childCount: row.childCount } : {}),
    ...(row.pendingQuestion !== undefined ? { pendingQuestion: row.pendingQuestion } : {}),
    ...(row.pendingQuestionId !== undefined ? { pendingQuestionId: row.pendingQuestionId } : {})
  }))
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

/**
 * Compact on purpose: the reader is a model, not a human. Pretty-printing costs
 * one token per indent run and per newline on every field of every tool result
 * — pure waste in a loop the orchestrator runs hundreds of times. Nothing in
 * the app parses the text back except tests, which use `JSON.parse`.
 */
export function toolJson(body: unknown): ToolText {
  return toolText(JSON.stringify(body))
}

/** A tool-level failure: the model sees it as an error, the call still returns. */
export function toolError(body: Record<string, unknown>): ToolText {
  return { ...toolJson(body), isError: true }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
