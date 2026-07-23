import { describe, expect, it } from 'vitest'
import type { RunRetro } from './contracts'
import {
  MIN_ROUTING_SAMPLES,
  computeRoutingScores,
  routingScoreFor,
  wilsonLowerBound
} from './routingStats'

function retroWith(stats: Array<Partial<RunRetro['modelStats'][number]> & { provider: 'codex' | 'claude'; model: string }>): RunRetro {
  return {
    id: 'r1',
    planId: 'p1',
    goal: 'Test',
    summary: '',
    learnings: [],
    createdAt: 1,
    modelStats: stats.map((entry) => ({
      roles: [],
      tasks: 0,
      succeeded: 0,
      needsWork: 0,
      failed: 0,
      stopped: 0,
      failuresByKind: { infra: 0, cancelled: 0, model: 0 },
      failedAttempts: 0,
      failedAttemptsByKind: { infra: 0, cancelled: 0, model: 0 },
      gateFindings: 0,
      ...entry
    }))
  }
}

describe('routing stats', () => {
  it('aggregates judged outcomes across retros and excludes stopped tasks', () => {
    const scores = computeRoutingScores([
      retroWith([{ provider: 'codex', model: 'gpt-x', roles: ['backend'], succeeded: 4, needsWork: 1, failed: 1, stopped: 7 }]),
      retroWith([{ provider: 'codex', model: 'gpt-x', roles: ['frontend'], succeeded: 2, needsWork: 0, failed: 0 }])
    ])

    expect(scores).toHaveLength(1)
    expect(scores[0]).toMatchObject({
      provider: 'codex',
      model: 'gpt-x',
      roles: ['backend', 'frontend'],
      samples: 8,
      successRate: 6 / 8,
      reworkRate: 1 / 8
    })
  })

  it('ranks a well-proven model above a lucky single-sample one (Wilson lower bound)', () => {
    const scores = computeRoutingScores([
      retroWith([
        { provider: 'codex', model: 'proven', succeeded: 9, failed: 1 },
        { provider: 'codex', model: 'lucky', succeeded: 1, failed: 0 }
      ])
    ])

    const proven = scores.find((entry) => entry.model === 'proven')!
    const lucky = scores.find((entry) => entry.model === 'lucky')!
    expect(proven.successRate).toBeLessThan(lucky.successRate)
    expect(proven.score).toBeGreaterThan(lucky.score)
  })

  it('withholds a routing score below the sample floor', () => {
    const scores = computeRoutingScores([
      retroWith([
        { provider: 'codex', model: 'thin', succeeded: MIN_ROUTING_SAMPLES - 1 },
        { provider: 'claude', model: 'thick', succeeded: MIN_ROUTING_SAMPLES }
      ])
    ])

    expect(routingScoreFor(scores, 'codex', 'thin')).toBeUndefined()
    expect(routingScoreFor(scores, 'claude', 'thick')).toMatchObject({ samples: MIN_ROUTING_SAMPLES })
  })

  it('keeps the Wilson bound within [0, 1] and monotonic in evidence', () => {
    expect(wilsonLowerBound(0, 0)).toBe(0)
    expect(wilsonLowerBound(5, 5)).toBeGreaterThan(wilsonLowerBound(1, 1))
    expect(wilsonLowerBound(50, 100)).toBeGreaterThan(wilsonLowerBound(5, 10))
    expect(wilsonLowerBound(100, 100)).toBeLessThanOrEqual(1)
  })
})
