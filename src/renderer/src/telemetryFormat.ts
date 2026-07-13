function metric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function compact(value: number, suffix: string): string {
  const rounded = Math.round(value * 10) / 10
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1).replace('.', ',')
  return `${text}${suffix}`
}

/** Shared token presentation for every renderer usage surface. */
export function formatTokenCount(value: number): string {
  const safeValue = metric(value)
  if (safeValue == null) return '—'
  if (safeValue >= 1_000_000) return compact(safeValue / 1_000_000, 'M')
  if (safeValue >= 1_000) return compact(safeValue / 1_000, 'k')
  return Math.round(safeValue).toLocaleString('de-DE')
}

/** Keep cost precision identical between AgentPane and LimitsPanel. */
export function formatUsd(value: number): string {
  const safeValue = metric(value)
  return safeValue == null ? '—' : `$${safeValue.toFixed(4)}`
}

/** Describe missing input/output counters explicitly instead of inventing zeroes. */
export function formatTokenBreakdown(tokensIn?: number, tokensOut?: number): string {
  const input = metric(tokensIn)
  const output = metric(tokensOut)
  return [
    input == null ? 'Eingabe nicht gemeldet' : `${formatTokenCount(input)} Eingabe`,
    output == null ? 'Ausgabe nicht gemeldet' : `${formatTokenCount(output)} Ausgabe`
  ].join(' · ')
}
