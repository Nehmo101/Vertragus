import type { OrchestratorSnapshot } from '@shared/orchestrator'
import { summarizeUsageGroup, type TelemetrySummary } from '@shared/telemetry'
import { formatTokenCount, formatUsd } from '@renderer/telemetryFormat'

/**
 * Session-wide usage sum over every task of the active workspace snapshot.
 * Pure aggregation of provider-reported task telemetry (tokens, cost, steps);
 * metrics no provider reported stay undefined instead of becoming a false 0.
 */
export function sumSessionUsage(
  snapshot: Pick<OrchestratorSnapshot, 'tasks'>
): TelemetrySummary {
  return summarizeUsageGroup((snapshot.tasks ?? []).map((task) => task.usage))
}

/**
 * Compact one-line session sum, e.g. "2,3M Token · ≈ $4.1000 · 128 Schritte".
 * Only reported metrics appear; null when the session has no telemetry at all.
 */
export function formatSessionUsage(summary: TelemetrySummary): string | null {
  if (summary.status === 'absent') return null
  const parts: string[] = []
  if (summary.tokens != null) parts.push(`${formatTokenCount(summary.tokens)} Token`)
  if (summary.costUsd != null) parts.push(`≈ ${formatUsd(summary.costUsd)}`)
  if (summary.steps != null)
    parts.push(summary.steps === 1 ? '1 Schritt' : `${summary.steps} Schritte`)
  return parts.length > 0 ? parts.join(' · ') : null
}
