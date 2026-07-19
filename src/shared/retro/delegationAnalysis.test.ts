import { describe, expect, it } from 'vitest'
import { analyzeDelegation, deriveDelegationOutcome } from './delegationAnalysis'
import type { DelegationTaskObservation } from './contracts'
import type { PlanDelegationEstimate } from '../planEstimate'

function estimate(partial: Partial<PlanDelegationEstimate> = {}): PlanDelegationEstimate {
  return {
    recommendation: 'delegate',
    taskCount: 3,
    requiredTaskCount: 3,
    parallelWidth: 3,
    effectiveParallelWidth: 3,
    hasIntegrator: false,
    declaredMaxParallel: 3,
    underParallelized: false,
    reason: 'test',
    ...partial
  }
}

function obs(partial: Partial<DelegationTaskObservation> = {}): DelegationTaskObservation {
  return { status: 'success', committed: false, noChanges: false, ...partial }
}

describe('deriveDelegationOutcome', () => {
  it('counts commits, no-changes and failures', () => {
    const outcome = deriveDelegationOutcome([
      obs({ committed: true }),
      obs({ noChanges: true }),
      obs({ status: 'error' }),
      obs({ status: 'stopped' })
    ])
    expect(outcome.dispatchedTasks).toBe(4)
    expect(outcome.committedTasks).toBe(1)
    expect(outcome.noChangeTasks).toBe(1)
    expect(outcome.failedTasks).toBe(2)
  })

  it('computes peak parallelism from overlapping intervals', () => {
    const outcome = deriveDelegationOutcome([
      obs({ startedAt: 0, finishedAt: 100 }),
      obs({ startedAt: 10, finishedAt: 50 }),
      obs({ startedAt: 60, finishedAt: 90 })
    ])
    // Tasks 1+2 overlap (2), then 1+3 overlap (2); never 3 at once.
    expect(outcome.observedPeakParallel).toBe(2)
  })

  it('does not count back-to-back intervals as overlapping', () => {
    const outcome = deriveDelegationOutcome([
      obs({ startedAt: 0, finishedAt: 50 }),
      obs({ startedAt: 50, finishedAt: 100 })
    ])
    expect(outcome.observedPeakParallel).toBe(1)
  })
})

describe('analyzeDelegation', () => {
  it('confirms solo when at most one task ran', () => {
    const result = analyzeDelegation(estimate({ recommendation: 'solo', effectiveParallelWidth: 1 }), [
      obs({ committed: true })
    ])
    expect(result.verdict).toBe('justified')
    expect(result.note).toContain('bestätigt')
  })

  it('flags overhead when a team was spun up despite a solo estimate', () => {
    const result = analyzeDelegation(estimate({ recommendation: 'solo', effectiveParallelWidth: 1 }), [
      obs({ committed: true }),
      obs({ noChanges: true }),
      obs({ noChanges: true })
    ])
    expect(result.verdict).toBe('overhead')
  })

  it('confirms delegation when two or more subagents committed real work', () => {
    const result = analyzeDelegation(estimate(), [
      obs({ committed: true }),
      obs({ committed: true }),
      obs({ committed: true })
    ])
    expect(result.verdict).toBe('justified')
  })

  it('notes under-parallelization even when delegation paid off', () => {
    const result = analyzeDelegation(
      estimate({ underParallelized: true, declaredMaxParallel: 1 }),
      [obs({ committed: true }), obs({ committed: true })]
    )
    expect(result.verdict).toBe('justified')
    expect(result.note).toContain('maxParallel')
  })

  it('flags overhead when a delegated team produced almost no changes', () => {
    const result = analyzeDelegation(estimate(), [
      obs({ committed: true }),
      obs({ noChanges: true }),
      obs({ status: 'error' })
    ])
    expect(result.verdict).toBe('overhead')
    expect(result.note).toContain('Solo hätte')
  })

  it('is inconclusive without terminal tasks', () => {
    const result = analyzeDelegation(estimate(), [])
    expect(result.verdict).toBe('inconclusive')
  })
})
