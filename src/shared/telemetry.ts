import type { AgentMode, AgentUsage } from './agents'

/** Availability of the metrics Orca-Strator can display for an agent/provider. */
export type TelemetryStatus = 'absent' | 'partial' | 'present'

export interface TelemetrySummary {
  status: TelemetryStatus
  tokens?: number
  costUsd?: number
  steps?: number
}

export const TELEMETRY_STATUS_LABELS: Record<Exclude<TelemetryStatus, 'present'>, string> = {
  absent: 'Telemetrie fehlt',
  partial: 'Telemetrie teilweise'
}

export const TELEMETRY_STATUS_TITLES: Record<Exclude<TelemetryStatus, 'present'>, string> = {
  absent: 'Dieser Provider liefert derzeit keine Telemetrie an Orca-Strator.',
  partial: 'Dieser Provider liefert nur einen Teil der Telemetrie an Orca-Strator.'
}

export interface TelemetryAbsence {
  label: string
  title: string
}

/**
 * Explains why an agent shows no metrics. Interactive agents run a live TUI and
 * never stream structured usage, so we say so plainly instead of implying the
 * provider is broken — only dispatched (headless) tasks report tokens/cost.
 */
export function absentTelemetryNotice(mode: AgentMode): TelemetryAbsence {
  if (mode === 'interactive') {
    return {
      label: 'Telemetrie nur für Tasks',
      title:
        'Interaktive Agents liefern keine strukturierte Nutzungstelemetrie an Orca-Strator. ' +
        'Tokens und Kosten erscheinen nur bei vom Orchestrator dispatchten Tasks.'
    }
  }
  return { label: TELEMETRY_STATUS_LABELS.absent, title: TELEMETRY_STATUS_TITLES.absent }
}

function metric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * Normalizes one provider report. A value of zero is telemetry, while missing,
 * invalid, or negative values remain unavailable instead of becoming a false 0.
 */
export function summarizeUsage(usage?: AgentUsage): TelemetrySummary {
  const tokensIn = metric(usage?.tokensIn)
  const tokensOut = metric(usage?.tokensOut)
  const costUsd = metric(usage?.costUsd)
  const steps = metric(usage?.steps)
  const reported = [tokensIn, tokensOut, costUsd, steps].filter((value) => value != null).length

  return {
    status: reported === 0 ? 'absent' : reported === 4 ? 'present' : 'partial',
    tokens: tokensIn != null || tokensOut != null ? (tokensIn ?? 0) + (tokensOut ?? 0) : undefined,
    costUsd,
    steps
  }
}

/** Combines provider reports without hiding unavailable telemetry behind zeroes. */
export function summarizeUsageGroup(usages: readonly (AgentUsage | undefined)[]): TelemetrySummary {
  const summaries = usages.map(summarizeUsage)
  const hasTokens = summaries.some((summary) => summary.tokens != null)
  const hasCost = summaries.some((summary) => summary.costUsd != null)
  const hasSteps = summaries.some((summary) => summary.steps != null)
  const hasTelemetry = hasTokens || hasCost || hasSteps

  return {
    status: !hasTelemetry ? 'absent' : summaries.length > 0 && summaries.every((summary) => summary.status === 'present') ? 'present' : 'partial',
    tokens: hasTokens ? summaries.reduce((total, summary) => total + (summary.tokens ?? 0), 0) : undefined,
    costUsd: hasCost ? summaries.reduce((total, summary) => total + (summary.costUsd ?? 0), 0) : undefined,
    steps: hasSteps ? summaries.reduce((total, summary) => total + (summary.steps ?? 0), 0) : undefined
  }
}
