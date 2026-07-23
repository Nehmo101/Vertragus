import { describe, expect, it } from 'vitest'
import type { VertragusTask } from '@shared/orchestrator'
import { computeBudgetSnapshot, computeIntegrationSnapshot } from './engineSnapshots'

function task(overrides: Partial<VertragusTask>): VertragusTask {
  return {
    id: overrides.id ?? 't1',
    title: 'T',
    role: 'worker',
    status: 'success',
    createdAt: 1,
    ...overrides
  }
}

describe('computeBudgetSnapshot', () => {
  it('aggregates tokens and cost across measured tasks and flags exceeded caps', () => {
    const snapshot = computeBudgetSnapshot(
      [
        task({ id: 'a', provider: 'codex', usage: { tokensIn: 10, tokensOut: 5, costUsd: 0.5 } }),
        task({ id: 'b', provider: 'claude', usage: { tokensIn: 20, tokensOut: 0, costUsd: 1 } })
      ],
      { maxTokens: 30, maxCostUsd: 10 }
    )
    expect(snapshot.tokens).toBe(35)
    expect(snapshot.costUsd).toBeCloseTo(1.5)
    expect(snapshot.exceeded).toBe(true)
    expect(snapshot.exceededBy).toEqual(['tokens'])
    expect(snapshot.tasksReported).toBe(2)
    expect(snapshot.tokenDataComplete).toBe(true)
    expect(snapshot.costDataComplete).toBe(true)
  })

  it('reports incomplete data when a measured task has no usage', () => {
    const snapshot = computeBudgetSnapshot(
      [task({ id: 'a', provider: 'codex' })],
      {}
    )
    expect(snapshot.tasksTotal).toBe(1)
    expect(snapshot.tasksReported).toBe(0)
    expect(snapshot.tokenDataComplete).toBe(false)
    expect(snapshot.costDataComplete).toBe(false)
    expect(snapshot.exceeded).toBe(false)
  })

  it('treats an empty task set as no data, never as complete', () => {
    const snapshot = computeBudgetSnapshot([], { maxTokens: 1 })
    expect(snapshot.tokens).toBe(0)
    expect(snapshot.tokenDataComplete).toBe(false)
    expect(snapshot.exceeded).toBe(false)
  })
})

describe('computeIntegrationSnapshot', () => {
  it('collects auto-PR items and derives the aggregate status', () => {
    const snapshot = computeIntegrationSnapshot(
      [
        task({ id: 'a', autoPrStatus: 'prepared', commit: 'c'.repeat(40) }),
        task({ id: 'b', autoPrStatus: 'skipped' })
      ],
      undefined,
      false
    )
    expect(snapshot.status).toBe('prepared')
    expect(snapshot.items.map((item) => item.taskId)).toEqual(['a'])
  })

  it('prioritizes publishing > awaiting-approval > blocked', () => {
    const blocked = [task({ id: 'a', autoPrStatus: 'blocked' })]
    expect(computeIntegrationSnapshot(blocked, undefined, true).status).toBe('publishing')
    expect(
      computeIntegrationSnapshot(
        blocked,
        {
          id: 'p1',
          kind: 'pr-publication',
          profileId: 'p',
          workspaceSessionId: 's',
          title: 'x',
          summary: 'y',
          createdAt: 1,
          actions: []
        },
        false
      ).status
    ).toBe('awaiting-approval')
    expect(computeIntegrationSnapshot(blocked, undefined, false).status).toBe('blocked')
  })

  it('flags failed remote CI as blocked', () => {
    const snapshot = computeIntegrationSnapshot(
      [task({ id: 'a', autoPrStatus: 'published', remoteCiStatus: 'failed' })],
      undefined,
      false
    )
    expect(snapshot.status).toBe('blocked')
  })
})
