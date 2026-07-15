import { redactDiagnosticValue } from '@main/diagnostics/runJournal'
import type { TaskReviewDiff } from '@shared/ipc'

export const REMOTE_DIFF_MAX_BYTES = 120_000

export function redactAndLimitRemoteDiff(
  input: TaskReviewDiff,
  maxBytes = REMOTE_DIFF_MAX_BYTES
): TaskReviewDiff {
  const redacted = redactDiagnosticValue(input.diff)
  const value = typeof redacted === 'string' ? redacted : String(redacted)
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.byteLength <= maxBytes) return { ...input, diff: value }
  const suffix = '\n\n[Remote-Diff redigiert und für Mobilgeräte gekürzt]'
  const contentBytes = Math.max(0, maxBytes - Buffer.byteLength(suffix, 'utf8'))
  let limited = bytes.subarray(0, contentBytes).toString('utf8')
  if (limited.endsWith('\uFFFD')) limited = limited.slice(0, -1)
  return {
    taskId: input.taskId,
    diff: `${limited}${suffix}`,
    truncated: true
  }
}
