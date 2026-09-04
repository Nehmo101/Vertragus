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
  const scaled = count < 1_000_000 ? count / 1_000 : count / 1_000_000
  const suffix = count < 1_000_000 ? 'k' : 'M'
  const formatted = new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
    minimumFractionDigits: 0
  }).format(scaled)
  return `${formatted}${suffix}`
}

export function tokenUsageCount(usage: TokenUsage): number {
  return usage.kind === 'consumption' ? usage.total : usage.used
}
