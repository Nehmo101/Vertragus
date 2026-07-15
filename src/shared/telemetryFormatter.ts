import type { TelemetrySummary } from './telemetry'

export const TELEMETRY_UNAVAILABLE = '—'

export interface FormattedTelemetry {
  tokens: string
  costUsd: string
  steps: string
}

function metric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function compact(value: number, suffix: string): string {
  const rounded = Math.round(value * 10) / 10
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1).replace('.', ',')
  return `${text}${suffix}`
}

/** Formats token counters compactly while keeping missing or invalid telemetry explicit. */
export function formatTelemetryTokens(value: unknown): string {
  const safeValue = metric(value)
  if (safeValue == null) return TELEMETRY_UNAVAILABLE
  if (safeValue >= 1_000_000) return compact(safeValue / 1_000_000, 'M')
  if (safeValue >= 1_000) return compact(safeValue / 1_000, 'k')
  return Math.round(safeValue).toLocaleString('de-DE')
}

/** Uses one precision for USD telemetry across all presentation surfaces. */
export function formatTelemetryUsd(value: unknown): string {
  const safeValue = metric(value)
  return safeValue == null ? TELEMETRY_UNAVAILABLE : `$${safeValue.toFixed(4)}`
}

/** Formats a step counter without treating an unavailable value as zero. */
export function formatTelemetrySteps(value: unknown): string {
  const safeValue = metric(value)
  return safeValue == null
    ? TELEMETRY_UNAVAILABLE
    : Math.round(safeValue).toLocaleString('de-DE')
}

/** Produces display-ready telemetry without modifying the source summary. */
export function formatTelemetry(summary: Pick<TelemetrySummary, 'tokens' | 'costUsd' | 'steps'>): FormattedTelemetry {
  return {
    tokens: formatTelemetryTokens(summary.tokens),
    costUsd: formatTelemetryUsd(summary.costUsd),
    steps: formatTelemetrySteps(summary.steps)
  }
}
