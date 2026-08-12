import { describe, expect, it } from 'vitest'
import type { RoleModelStats, RunRetro } from '../schema/retro'
import {
  MIN_ROUTING_SAMPLES,
  computeRoutingScores,
  routingScoreFor,
  wilsonLowerBound
} from './routingStats'

function retroWith(
  stats: Array<Partial<RoleModelStats> & { providerId: string; model: string }>
): RunRetro {
  return {
    id: 'run-1',
    workspaceId: 'ws-1',
    workspaceName: 'Limbo',
    profileId: 'profile-1',
    summary: '',
    createdAt: 1,
    endedAt: 2,
    stats: stats.map((entry) => ({
      roleId: 'worker',
      started: 0,
      succeeded: 0,
      blocked: 0,
      failed: 0,
      unconfirmedExits: 0,
      stopped: 0,
      ...entry
    }))
  }
}

describe('routing stats', () => {
  it('aggregates judged outcomes across retros and excludes stopped agents', () => {
    const scores = computeRoutingScores([
      retroWith([
        {
          providerId: 'codex',
          model: 'gpt-x',
          roleId: 'backend',
          succeeded: 4,
          blocked: 1,
          failed: 1,
          stopped: 7
        }
      ]),
      retroWith([{ providerId: 'codex', model: 'gpt-x', roleId: 'frontend', succeeded: 2 }])
    ])

    expect(scores).toHaveLength(1)
    expect(scores[0]).toMatchObject({
      providerId: 'codex',
      model: 'gpt-x',
      roles: ['backend', 'frontend'],
      samples: 8,
      successRate: 6 / 8,
      blockedRate: 1 / 8
    })
  })

  it('ranks a well-proven model above a lucky single-sample one (Wilson lower bound)', () => {
    const scores = computeRoutingScores([
      retroWith([
        { providerId: 'codex', model: 'proven', succeeded: 9, failed: 1 },
        { providerId: 'codex', model: 'lucky', succeeded: 1 }
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
        { providerId: 'codex', model: 'thin', succeeded: MIN_ROUTING_SAMPLES - 1 },
        { providerId: 'claude', model: 'thick', succeeded: MIN_ROUTING_SAMPLES }
      ])
    ])

    expect(routingScoreFor(scores, 'codex', 'thin')).toBeUndefined()
    expect(routingScoreFor(scores, 'claude', 'thick')).toMatchObject({
      samples: MIN_ROUTING_SAMPLES
    })
  })

  it('keeps the Wilson bound within [0, 1] and monotonic in evidence', () => {
    expect(wilsonLowerBound(0, 0)).toBe(0)
    expect(wilsonLowerBound(5, 5)).toBeGreaterThan(wilsonLowerBound(1, 1))
    expect(wilsonLowerBound(50, 100)).toBeGreaterThan(wilsonLowerBound(5, 10))
    expect(wilsonLowerBound(100, 100)).toBeLessThanOrEqual(1)
  })
})
