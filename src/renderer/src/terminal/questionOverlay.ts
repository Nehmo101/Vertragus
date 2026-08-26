/**
 * CLI question overlay — pure decisions so they test in Node without a DOM.
 *
 * The overlay is a first-class H1 answer surface: it sits over xterm, its
 * keys never reach the PTY, and Submit goes through `terminal:answerQuestion`
 * (the same host path as the panel badge). Escape hides it; the question
 * stays open on the panel.
 */
import { shouldFocusTerminal } from './windowFocus'

/**
 * Registry key for `ask_user`. Duplicated from `src/main/mcp/types.ts` because
 * the web bundle cannot import main; `questionOverlay.test.ts` pins the match.
 */
export const USER_QUESTION_AGENT_ID = 'user'

export interface TerminalQuestionView {
  questionId: string
  question: string
  agentId: string
  fromName?: string
}

export function overlayShows(
  question: TerminalQuestionView | null | undefined,
  dismissedQuestionId: string | null
): boolean {
  return Boolean(question && question.questionId !== dismissedQuestionId)
}

export type OverlayKeyAction = 'submit' | 'hide' | null

/** Enter submits, Shift+Enter is a newline (leave to the textarea), Escape hides. */
export function overlayKeyAction(event: { key: string; shiftKey: boolean }): OverlayKeyAction {
  if (event.key === 'Escape') return 'hide'
  if (event.key === 'Enter' && !event.shiftKey) return 'submit'
  return null
}

/** False while the overlay is up — xterm must not see those keystrokes. */
export function shouldForwardKeyToPty(overlayVisible: boolean): boolean {
  return !overlayVisible
}

/**
 * Autofocus the overlay textarea only when this window already has the OS
 * keyboard. Same Windows path as xterm: focusing a textarea activates the
 * BrowserWindow even after showInactive() — a worker question must not yank
 * the user out of the orchestrator CLI. See {@link shouldFocusTerminal}.
 */
export function shouldAutofocusOverlay(hasDocumentFocus: boolean): boolean {
  return shouldFocusTerminal(hasDocumentFocus)
}

export function isUserQuestion(question: Pick<TerminalQuestionView, 'agentId'>): boolean {
  return question.agentId === USER_QUESTION_AGENT_ID
}

export function canSubmitAnswer(text: string): boolean {
  return text.trim().length > 0
}
