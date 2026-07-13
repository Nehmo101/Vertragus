import { describe, expect, it } from 'vitest'
import { formatTokenBreakdown, formatTokenCount, formatUsd } from './telemetryFormat'

describe('renderer telemetry formatting', () => {
  it('uses one compact token format for every usage surface', () => {
    expect(formatTokenCount(999)).toBe('999')
    expect(formatTokenCount(1_250)).toBe('1,3k')
    expect(formatTokenCount(2_000_000)).toBe('2M')
  })

  it('uses a single cost precision', () => {
    expect(formatUsd(0.01)).toBe('$0.0100')
    expect(formatUsd(Number.NaN)).toBe('—')
  })

  it('labels missing token directions instead of displaying false zeroes', () => {
    expect(formatTokenBreakdown(undefined, 8)).toBe('Eingabe nicht gemeldet · 8 Ausgabe')
    expect(formatTokenBreakdown(1_250, undefined)).toBe('1,3k Eingabe · Ausgabe nicht gemeldet')
  })
})
