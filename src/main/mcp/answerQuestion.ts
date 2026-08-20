/**
 * The ONE host path that answers an agent question — shared by the
 * orchestrator's MCP tool (`send_to_agent{questionId}`), the panel's question
 * badge and the remote gateway's `answer_question` command (H1).
 *
 * All three callers go through {@link answerAgentQuestion} against the same
 * {@link PendingQuestions} registry, so there is exactly one truth about which
 * questions are open and one delivery order: sentinel questions are typed into
 * the agent's PTY FIRST (via the registry entry's `deliverAnswer`), and only a
 * delivered answer closes the registry entry. MCP-tool questions have no
 * `deliverAnswer` — closing the entry is what wakes the parked
 * `ask_orchestrator` waiter.
 */
import type { PendingQuestions } from './pendingQuestions'
import { errorMessage } from './types'

export type AnswerQuestionOutcome =
  | { ok: true; agentId: string; questionId: string }
  | {
      ok: false
      error: 'unknown_question' | 'question_agent_mismatch' | 'answer_delivery_failed'
      questionId: string
      /** The agent that actually owns the question (mismatch case). */
      expectedAgentId?: string
      /** Underlying failure (delivery case). */
      message?: string
    }

/**
 * Answer one open question. Never throws: every failure is a value the caller
 * turns into its own error shape (tool error, IPC rejection, gateway error).
 * A failed PTY delivery leaves the question OPEN so the caller can retry with
 * the same questionId.
 */
export async function answerAgentQuestion(
  questions: PendingQuestions,
  agentId: string,
  questionId: string,
  text: string
): Promise<AnswerQuestionOutcome> {
  const open = questions.get(questionId)
  if (!open) return { ok: false, error: 'unknown_question', questionId }
  if (open.agentId !== agentId) {
    return {
      ok: false,
      error: 'question_agent_mismatch',
      questionId,
      expectedAgentId: open.agentId
    }
  }
  // Sentinel questions: deliver to the PTY FIRST, then close the registry.
  // Closing first left a failed seed with no open question and a stuck agent
  // (dedup still held the ASK hash). MCP questions have no deliverAnswer —
  // answer() alone wakes waitForAnswer.
  if (open.deliverAnswer) {
    try {
      await open.deliverAnswer(text)
    } catch (error) {
      return {
        ok: false,
        error: 'answer_delivery_failed',
        questionId,
        message: errorMessage(error)
      }
    }
  }
  questions.answer(questionId, text)
  return { ok: true, agentId, questionId }
}
