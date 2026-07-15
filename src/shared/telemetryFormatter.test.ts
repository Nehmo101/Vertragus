import { describe, expect, it } from 'vitest'
import {
  TELEMETRY_UNAVAILABLE,
  formatTelemetry,
  formatTelemetrySteps,
  formatTelemetryTokens,
  formatTelemetryUsd
} from './telemetryFormatter'

describe('telemetryFormatter', () => {
  it('formats token counters using compact German decimals', () => {
    expect(formatTelemetryTokens(999)).toBe('999')
    expect(formatTelemetryTokens(1_250)).toBe('1,3k')
    expect(formatTelemetryTokens(2_000_000)).toBe('2M')
  })

  it('keeps invalid and unavailable metrics distinct from zero', () => {
    expect(formatTelemetryTokens(undefined)).toBe(TELEMETRY_UNAVAILABLE)
    expect(formatTelemetryUsd(Number.NaN)).toBe(TELEMETRY_UNAVAILABLE)
    expect(formatTelemetrySteps(-1)).toBe(TELEMETRY_UNAVAILABLE)
    expect(formatTelemetryTokens(0)).toBe('0')
    expect(formatTelemetryUsd(0)).toBe('$0.0000')
  })

  it('formats a summary without mutating it', () => {
    const summary = { tokens: 1_250, costUsd: 0.01, steps: 1_234 }

    expect(formatTelemetry(summary)).toEqual({
      tokens: '1,3k',
      costUsd: '$0.0100',
      steps: '1.234'
    })
    expect(summary).toEqual({ tokens: 1_250, costUsd: 0.01, steps: 1_234 })
  })
})
