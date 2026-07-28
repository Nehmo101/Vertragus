import { describe, expect, it } from 'vitest'
import type { VertragusTask } from '@shared/orchestrator'
import { formatSessionUsage, sumSessionUsage } from './orchUsage'

function task(id: string, usage?: VertragusTask['usage']): VertragusTask {
  return {
    id,
    title: `Task ${id}`,
    role: 'worker',
    status: 'success',
    createdAt: 1,
    usage
  }
}

describe('sumSessionUsage', () => {
  it('reports absent telemetry for an empty session', () => {
    const summary = sumSessionUsage({ tasks: [] })
    expect(summary.status).toBe('absent')
    expect(summary.tokens).toBeUndefined()
    expect(summary.costUsd).toBeUndefined()
    expect(summary.steps).toBeUndefined()
  })

  it('reports absent telemetry when no task carries usage', () => {
    expect(sumSessionUsage({ tasks: [task('a'), task('b')] }).status).toBe('absent')
  })

  it('sums partial telemetry without inventing zeroes for missing metrics', () => {
    const summary = sumSessionUsage({
      tasks: [task('a', { tokensIn: 1_000, tokensOut: 500 }), task('b', { steps: 3 })]
    })
    expect(summary.status).toBe('partial')
    expect(summary.tokens).toBe(1_500)
    expect(summary.steps).toBe(3)
    expect(summary.costUsd).toBeUndefined()
  })

  it('sums tokens, cost and steps across all tasks of the workspace', () => {
    const summary = sumSessionUsage({
      tasks: [
        task('a', { tokensIn: 2_000_000, tokensOut: 200_000, costUsd: 3.5, steps: 100 }),
        task('b', { tokensIn: 80_000, tokensOut: 20_000, costUsd: 0.6, steps: 28 })
      ]
    })
    expect(summary.status).toBe('present')
    expect(summary.tokens).toBe(2_300_000)
    expect(summary.costUsd).toBeCloseTo(4.1)
    expect(summary.steps).toBe(128)
  })
})

describe('formatSessionUsage', () => {
  it('returns null when the session has no telemetry', () => {
    expect(formatSessionUsage(sumSessionUsage({ tasks: [] }))).toBeNull()
    expect(formatSessionUsage(sumSessionUsage({ tasks: [task('a')] }))).toBeNull()
  })

  it('formats the full compact session line', () => {
    const summary = sumSessionUsage({
      tasks: [task('a', { tokensIn: 2_000_000, tokensOut: 300_000, costUsd: 4.1, steps: 128 })]
    })
    expect(formatSessionUsage(summary)).toBe('2,3M Token · ≈ $4.1000 · 128 Schritte')
  })

  it('omits metrics no provider reported', () => {
    const tokensOnly = sumSessionUsage({ tasks: [task('a', { tokensIn: 12_000 })] })
    expect(formatSessionUsage(tokensOnly)).toBe('12k Token')

    const stepsOnly = sumSessionUsage({ tasks: [task('a', { steps: 7 })] })
    expect(formatSessionUsage(stepsOnly)).toBe('7 Schritte')
  })

  it('uses the German singular for exactly one step', () => {
    const summary = sumSessionUsage({ tasks: [task('a', { steps: 1 })] })
    expect(formatSessionUsage(summary)).toBe('1 Schritt')
  })
})
