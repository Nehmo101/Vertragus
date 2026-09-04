import type { TokenUsage } from '@shared/schema/events'
import type { Locale } from '../i18n'

/**
 * Compact token count: 842, 12.4k / 12,4k, 1.2M / 1,2M.
 * One decimal, trailing ".0" dropped, decimal separator via Intl.
 */
export function formatTokenCount(count: number, locale: Locale): string {
  if (!Number.isFinite(count) || count < 0) return '0'
  if (count < 1_000) {
    return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(count)
  }
  const compact = new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
    minimumFractionDigits: 0,
    useGrouping: false
  })
  // Round to one decimal BEFORE picking the tier: 999,950 is "1M", never
  // "1,000k" (which the grouping separator would otherwise paint).
  const thousands = Math.round(count / 100) / 10
  if (thousands < 1_000) return `${compact.format(thousands)}k`
  return `${compact.format(Math.round(count / 100_000) / 10)}M`
}

export function tokenUsageCount(usage: TokenUsage): number {
  return usage.kind === 'consumption' ? usage.total : usage.used
}
