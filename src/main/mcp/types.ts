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
 * (after a successful `startAgent`), `agent_stopped` (after a successful
 * `stopAgent`), and — for agents that talk to Vertragus over MCP —
 * `agent_done` / `agent_question` / `agent_progress` from the subagent tools.
 * The host pushes `agent_exited` (only it can observe a process dying unasked)
 * and, for `mcp: none` (sentinel) providers, `agent_done` / `agent_progress`
 * parsed from PTY sentinel lines — for those agents the host *is* the reporting
 * channel. A host must NOT duplicate MCP-tool events for an MCP-attached agent,
 * and the MCP tools must not invent PTY-sentinel events.
 */
import type { EventQueue } from './eventQueue'
import type { PendingQuestions } from './pendingQuestions'
import type { ReportingMode } from '@shared/prompts/contract'

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
 * Everything the MCP tools need from the process/window world. Implemented by
 * the WorkspaceManager; faked wholesale in tests.
 */
export interface AgentHost {
  startAgent(input: StartAgentInput): Promise<StartedAgent>
  /** Type text into the agent's PTY. */
  sendToAgent(agentId: string, text: string): Promise<void>
  /** Kill the agent; `false` when there was nothing (left) to kill. */
  stopAgent(agentId: string): Promise<boolean>
  /** ANSI-stripped tail of the agent's output. */
  readOutput(agentId: string, lines: number): Promise<string>
  listAgents(): AgentSummary[]
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
