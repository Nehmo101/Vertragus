/**
 * Pure composition of an AgentResumeState — the per-agent piece of session
 * persistence. Side-effect free (no fs / electron) so it is unit-testable;
 * AgentManager captures and the session store persists.
 */
import type { AgentInstanceInfo, AgentResumeState } from '@shared/agents'
import { tailScrollback } from '@main/agents/handoff'
import { redactDiagnosticValue } from '@main/diagnostics/runJournal'

/** Larger than a handoff briefing (24k): this is the only history that survives. */
export const RESUME_SCROLLBACK_CHARS = 64_000

export function buildAgentResumeState(
  info: AgentInstanceInfo,
  scrollback: string,
  capturedAt: number
): AgentResumeState {
  // The preflight report is bulky runtime diagnostics with no resume value.
  const compact: AgentInstanceInfo = { ...info, preflight: undefined }
  return {
    info: redactDiagnosticValue(compact) as AgentInstanceInfo,
    scrollbackTail: redactDiagnosticValue(
      tailScrollback(scrollback, RESUME_SCROLLBACK_CHARS)
    ) as string,
    capturedAt
  }
}
