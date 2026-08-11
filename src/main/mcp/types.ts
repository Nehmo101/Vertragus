/**
 * The contract between the MCP layer and the rest of the app.
 *
 * The MCP layer knows nothing about PTYs, windows, worktrees or providers. It
 * talks to an {@link AgentHost} — implemented by the WorkspaceManager — and to
 * an {@link EventQueue}. That keeps the whole orchestration loop testable with
 * a fake host and no Electron in sight.
 *
 * ## Who pushes which event
 * The MCP layer pushes `agent_started` (after a successful `startAgent`),
 * `agent_done`, `agent_question`, `agent_progress` (subagent tools) and
 * `agent_stopped` (after a successful `stopAgent`). The host pushes exactly one
 * event kind on its own: `agent_exited`, because only it can observe a process
 * dying unasked. A host must NOT duplicate the events listed above.
 */
import type { EventQueue } from './eventQueue'
import type { PendingQuestions } from './pendingQuestions'

/** What `start_agent` hands the host. */
export interface StartAgentInput {
  role: string
  /** Full seed text — task plus the appended contract. */
  task: string
  model?: string
  /** Run in an isolated git worktree instead of the shared repo. */
  worktree?: boolean
}

/** What the host reports back once the agent process is up and seeded. */
export interface StartedAgent {
  agentId: string
  name: string
  role: string
  worktreePath?: string
}

/** One row of `list_agents` / the `agentsSummary` in `await_events`. */
export interface AgentSummary {
  agentId: string
  name: string
  role: string
  status: string
  model?: string
  worktreePath?: string
  /** Seconds since the agent's PTY last produced output. */
  lastOutputAgeSec: number
  /** Text of the agent's currently unanswered question, when it has one. */
  pendingQuestion?: string
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
