/**
 * The question inbox: every open question in the run, in one list.
 *
 * On a phone the fold is the enemy. A question is the only thing on this
 * screen that *blocks* a run, and the old client hid it inside whichever card
 * happened to own it — three workspaces down, behind a collapsed card. So the
 * questions are aggregated out of the workspace tree first and rendered at the
 * top; the cards render the same entries, which is why this returns plain data
 * and leaves every copy decision to the caller.
 *
 * Pure on purpose — the aggregation is the part that can silently drop a
 * question, and it is the part a unit test can hold.
 */
import { questionChoicesDisplay } from '@shared/questionChoices'
import type { RemoteWorkspaceSummary } from '@shared/remote/protocol'

/**
 * 'user' is the orchestrator's `ask_user`, answered under the reserved agent
 * id "user"; 'agent' is a subagent's open MCP question.
 */
export type InboxKind = 'user' | 'agent'

export interface InboxEntry {
  /**
   * Stable identity for React keys and for the draft store. Question ids are
   * unique per registry, not per run, so the workspace and the addressee are
   * part of the key — a draft must never surface under someone else's question.
   */
  key: string
  kind: InboxKind
  workspaceId: string
  workspaceName: string
  /** What `answer_question` addresses: an agent id, or "user". */
  agentId: string
  /** Absent for an `ask_user` — that question comes from the run, not a peer. */
  agentName?: string
  questionId: string
  question: string
  /** Structured labels from the wire; the UI also parses the question text. */
  choices?: string[]
}

/** The reserved addressee the gateway accepts for an `ask_user` answer. */
export const USER_AGENT_ID = 'user'

/**
 * Every answerable question across the list, `ask_user` first.
 *
 * Ordering is deliberate: an `ask_user` has the orchestrator itself parked on
 * it, so it costs the whole run, while a subagent's question costs one branch.
 * Within a kind the caller's workspace order is kept, so an inbox entry never
 * moves for a reason the user cannot see.
 *
 * A question without an id is dropped: `answer_question` has nothing to
 * address, so offering a text field for it would be a lie.
 */
export function questionInbox(workspaces: readonly RemoteWorkspaceSummary[]): InboxEntry[] {
  const user: InboxEntry[] = []
  const agents: InboxEntry[] = []
  for (const workspace of workspaces) {
    const asked = workspace.userQuestion
    if (asked && asked.question.trim() && asked.questionId) {
      user.push({
        key: `${workspace.workspaceId}:${USER_AGENT_ID}:${asked.questionId}`,
        kind: 'user',
        workspaceId: workspace.workspaceId,
        workspaceName: workspace.name,
        agentId: USER_AGENT_ID,
        questionId: asked.questionId,
        question: asked.question.trim(),
        ...(asked.choices && asked.choices.length > 0 ? { choices: asked.choices } : {})
      })
    }
    for (const agent of workspace.agents) {
      const question = agent.pendingQuestion?.trim()
      if (!question || !agent.pendingQuestionId) continue
      agents.push({
        key: `${workspace.workspaceId}:${agent.agentId}:${agent.pendingQuestionId}`,
        kind: 'agent',
        workspaceId: workspace.workspaceId,
        workspaceName: workspace.name,
        agentId: agent.agentId,
        agentName: agent.name,
        questionId: agent.pendingQuestionId,
        question,
        ...(agent.pendingQuestionChoices && agent.pendingQuestionChoices.length > 0
          ? { choices: agent.pendingQuestionChoices }
          : {})
      })
    }
  }
  return [...user, ...agents]
}

/** The entries a single card owns, in the inbox's own order. */
export function inboxEntriesFor(
  entries: readonly InboxEntry[],
  workspaceId: string
): InboxEntry[] {
  return entries.filter((entry) => entry.workspaceId === workspaceId)
}

/**
 * The question as it is read out. An `ask_user` is framed as addressed to the
 * human — without that frame it reads like a status line, and the difference
 * between "the run is asking you" and "an agent is thinking" is the whole
 * reason this screen exists.
 */
export function inboxPrompt(
  entry: Pick<InboxEntry, 'kind' | 'question' | 'choices'>,
  copy: { userQuestion: (question: string) => string }
): string {
  const { prompt } = questionChoicesDisplay(entry.question, entry.choices)
  return entry.kind === 'user' ? copy.userQuestion(prompt) : prompt
}

/** Where the question came from, for the line under it. */
export function inboxSource(entry: Pick<InboxEntry, 'workspaceName' | 'agentName'>): string {
  return entry.agentName ? `${entry.workspaceName} · ${entry.agentName}` : entry.workspaceName
}
