/**
 * Which MCP question a CLI window may show and answer (H1 overlay).
 *
 * Panel and phone already fold `WorkspaceSummary` into badges; the CLI overlay
 * is another surface on the same registry, not a second truth. This module is
 * the pure slice `createTerminalIpc` consults: ipc.ts must not import
 * WorkspaceManager, and a worker must never answer a sibling's question just
 * because it lives in the same renderer.
 *
 * One overlay at a time: `ask_user` first, else the oldest open child (panel
 * list order). A worker sees only its own. Authorization is workspace-scoped —
 * the sender never picks a foreign PTY or a foreign run.
 */
import { USER_QUESTION_AGENT_ID } from './mcp/types'

export { USER_QUESTION_AGENT_ID }

/** One open question as the overlay addresses it (no workspace id on the wire). */
export interface TerminalQuestionInbox {
  questionId: string
  question: string
  /** Registry addressee: {@link USER_QUESTION_AGENT_ID} or the asking agent. */
  agentId: string
  /** Asking agent's Commedia name; absent for `ask_user`. */
  fromName?: string
}

/** The workspace row the panel list already computed — enough to pick an inbox. */
export interface CliQuestionWorkspace {
  workspaceId: string
  userQuestion?: { questionId: string; question: string }
  agents: ReadonlyArray<{
    agentId: string
    name: string
    roleId: string
    pendingQuestion?: string
    pendingQuestionId?: string
  }>
}

export interface CliQuestionContext {
  senderAgentId: string
  workspaceId: string
  orchestratorId?: string
  memberIds: readonly string[]
  /** `ask_user` first, then agents in panel order (oldest-open per row). */
  open: readonly TerminalQuestionInbox[]
}

export type CliAnswerRefusal = 'unknown_question' | 'not_allowed'

/**
 * Late-bound from `index.ts` (pattern: {@link setTerminalInputSink}): list()
 * already has `userQuestion` / `pendingQuestionId`; answer() is the same
 * directory method the panel badge uses.
 */
export interface TerminalQuestionSource {
  contextFor(senderAgentId: string): CliQuestionContext | null
  answer(workspaceId: string, agentId: string, questionId: string, text: string): Promise<void>
}

/** Map the panel list into a per-sender context, or null when the sender is in no run. */
export function cliQuestionContext(
  senderAgentId: string,
  workspaces: readonly CliQuestionWorkspace[]
): CliQuestionContext | null {
  const workspace = workspaces.find((entry) =>
    entry.agents.some((agent) => agent.agentId === senderAgentId)
  )
  if (!workspace) return null

  const orchestratorId = workspace.agents.find((agent) => agent.roleId === 'orchestrator')?.agentId
  const open: TerminalQuestionInbox[] = []
  const asked = workspace.userQuestion
  if (asked?.questionId && asked.question.trim()) {
    open.push({
      questionId: asked.questionId,
      question: asked.question.trim(),
      agentId: USER_QUESTION_AGENT_ID
    })
  }
  for (const agent of workspace.agents) {
    const question = agent.pendingQuestion?.trim()
    if (!question || !agent.pendingQuestionId) continue
    open.push({
      questionId: agent.pendingQuestionId,
      question,
      agentId: agent.agentId,
      fromName: agent.name
    })
  }

  return {
    senderAgentId,
    workspaceId: workspace.workspaceId,
    ...(orchestratorId ? { orchestratorId } : {}),
    memberIds: workspace.agents.map((agent) => agent.agentId),
    open
  }
}

/**
 * One overlay at a time for this window. Orchestrator: `ask_user` first, else
 * the oldest remaining open question in the run. Worker: only its own.
 */
export function inboxForCliWindow(ctx: CliQuestionContext): TerminalQuestionInbox | null {
  if (ctx.orchestratorId === ctx.senderAgentId) return ctx.open[0] ?? null
  return ctx.open.find((entry) => entry.agentId === ctx.senderAgentId) ?? null
}

/**
 * A CLI may answer a question only when it is open in the sender's workspace,
 * and only when the sender is the orchestrator (user + children) or the
 * asking agent itself.
 */
export function authorizeCliAnswer(
  ctx: CliQuestionContext,
  target: { agentId: string; questionId: string }
): CliAnswerRefusal | null {
  const open = ctx.open.find(
    (entry) => entry.questionId === target.questionId && entry.agentId === target.agentId
  )
  if (!open) return 'unknown_question'
  if (ctx.orchestratorId === ctx.senderAgentId) return null
  if (target.agentId !== ctx.senderAgentId) return 'not_allowed'
  return null
}

export function sameQuestionInbox(
  left: TerminalQuestionInbox | null | undefined,
  right: TerminalQuestionInbox | null | undefined
): boolean {
  if (!left && !right) return true
  if (!left || !right) return false
  return (
    left.questionId === right.questionId &&
    left.agentId === right.agentId &&
    left.question === right.question &&
    left.fromName === right.fromName
  )
}
