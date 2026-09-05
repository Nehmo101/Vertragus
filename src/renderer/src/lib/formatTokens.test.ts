import { describe, expect, it } from 'vitest'
import { formatTokenCount, tokenUsageCount } from './formatTokens'

describe('formatTokenCount', () => {
  it('keeps counts under a thousand as full integers', () => {
    expect(formatTokenCount(842, 'en')).toBe('842')
    expect(formatTokenCount(0, 'en')).toBe('0')
  })

  it('compacts thousands and millions with a locale decimal separator', () => {
    expect(formatTokenCount(12_400, 'en')).toBe('12.4k')
    expect(formatTokenCount(12_400, 'de')).toBe('12,4k')
    expect(formatTokenCount(1_000, 'en')).toBe('1k')
    expect(formatTokenCount(1_250_000, 'en')).toBe('1.3M')
    expect(formatTokenCount(1_250_000, 'de')).toBe('1,3M')
  })

  it('promotes the tier when one-decimal rounding would reach 1000k', () => {
    expect(formatTokenCount(999_950, 'en')).toBe('1M')
    expect(formatTokenCount(999_950, 'de')).toBe('1M')
    expect(formatTokenCount(999_949, 'en')).toBe('999.9k')
    expect(formatTokenCount(999_949, 'de')).toBe('999,9k')
  })
})

describe('tokenUsageCount', () => {
  it('picks total for consumption and used for context', () => {
    expect(
      tokenUsageCount({ kind: 'consumption', input: 1, output: 2, total: 10 })
    ).toBe(10)
    expect(tokenUsageCount({ kind: 'context', used: 48_000, window: 100_000 })).toBe(48_000)
  })
})
