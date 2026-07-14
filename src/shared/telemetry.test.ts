import { describe, expect, it } from 'vitest'
import {
  absentTelemetryNotice,
  summarizeUsage,
  summarizeUsageGroup,
  TELEMETRY_STATUS_LABELS,
  TELEMETRY_STATUS_TITLES
} from './telemetry'

describe('summarizeUsage', () => {
  it('labels absent telemetry instead of turning it into zeroes', () => {
    expect(summarizeUsage()).toEqual({ status: 'absent', tokens: undefined, costUsd: undefined, steps: undefined })
    expect(summarizeUsage({})).toEqual({ status: 'absent', tokens: undefined, costUsd: undefined, steps: undefined })
  })

  it('keeps reported zeroes and labels incomplete reports', () => {
    expect(summarizeUsage({ tokensIn: 0, tokensOut: 0 })).toEqual({
      status: 'partial',
      tokens: 0,
      costUsd: undefined,
      steps: undefined
    })
  })

  it('labels a complete structured report as present', () => {
    expect(summarizeUsage({ tokensIn: 12, tokensOut: 8, costUsd: 0.01, steps: 2 })).toEqual({
      status: 'present',
      tokens: 20,
      costUsd: 0.01,
      steps: 2
    })
  })

  it('rejects malformed and negative metrics instead of displaying untrusted values', () => {
    expect(summarizeUsage({ tokensIn: Number.NaN, tokensOut: Number.POSITIVE_INFINITY, costUsd: -1, steps: -2 })).toEqual({
      status: 'absent',
      tokens: undefined,
      costUsd: undefined,
      steps: undefined
    })
  })
})

describe('absentTelemetryNotice', () => {
  it('explains that interactive agents only report via tasks', () => {
    const notice = absentTelemetryNotice('interactive')
    expect(notice.label).toBe('Telemetrie nur für Tasks')
    expect(notice.title).toMatch(/dispatchten Tasks/)
  })

  it('keeps the provider-oriented wording for task agents', () => {
    expect(absentTelemetryNotice('task')).toEqual({
      label: TELEMETRY_STATUS_LABELS.absent,
      title: TELEMETRY_STATUS_TITLES.absent
    })
  })
})

describe('summarizeUsageGroup', () => {
  it('labels mixed provider reports as partial while retaining the measured totals', () => {
    expect(summarizeUsageGroup([
      { tokensIn: 10, tokensOut: 5, costUsd: 0.02, steps: 1 },
      { tokensIn: 4, tokensOut: 2 }
    ])).toEqual({ status: 'partial', tokens: 21, costUsd: 0.02, steps: 1 })
  })
})
