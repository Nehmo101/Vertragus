import { describe, expect, it } from 'vitest'
import {
  analyzeDelegation,
  deriveDelegationOutcome,
  summarizeDelegationCalibration,
  toDelegationObservation
} from './delegationAnalysis'
import type { DelegationRetro, DelegationTaskObservation } from './contracts'
import type { OrchestratorDelegationEstimate, PlanDelegationEstimate } from '../planEstimate'

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

function selfEstimate(
  partial: Partial<OrchestratorDelegationEstimate> = {}
): OrchestratorDelegationEstimate {
  return {
    recommendation: 'delegate',
    expectedParallelTasks: 3,
    confidence: 'medium',
    rationale: 'test',
    createdAt: 0,
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

  it('omits self-calibration when no self-estimate was recorded', () => {
    const result = analyzeDelegation(estimate(), [obs({ committed: true })])
    expect(result.selfEstimate).toBeUndefined()
    expect(result.selfCalibration).toBeUndefined()
  })
})

describe('analyzeDelegation self-calibration', () => {
  it('grades a delegate prediction that paid off as accurate', () => {
    const result = analyzeDelegation(
      estimate({ recommendation: 'delegate' }),
      [obs({ committed: true }), obs({ committed: true })],
      selfEstimate({ recommendation: 'delegate' })
    )
    expect(result.selfCalibration).toMatchObject({ agreedWithStructure: true, grade: 'accurate' })
  })

  it('grades a delegate prediction that produced no parallel work as over-delegated', () => {
    const result = analyzeDelegation(
      estimate({ recommendation: 'solo', effectiveParallelWidth: 1 }),
      [obs({ committed: true }), obs({ noChanges: true }), obs({ status: 'error' })],
      selfEstimate({ recommendation: 'delegate' })
    )
    expect(result.selfCalibration).toMatchObject({
      agreedWithStructure: false,
      grade: 'over-delegated'
    })
  })

  it('grades a solo prediction that should have been a team as under-delegated', () => {
    const result = analyzeDelegation(
      estimate({ recommendation: 'delegate' }),
      [obs({ committed: true }), obs({ committed: true }), obs({ committed: true })],
      selfEstimate({ recommendation: 'solo', expectedParallelTasks: 1 })
    )
    expect(result.selfCalibration).toMatchObject({
      agreedWithStructure: false,
      grade: 'under-delegated'
    })
  })

  it('grades a solo prediction with no parallel work as accurate', () => {
    const result = analyzeDelegation(
      estimate({ recommendation: 'solo', effectiveParallelWidth: 1 }),
      [obs({ committed: true })],
      selfEstimate({ recommendation: 'solo', expectedParallelTasks: 1 })
    )
    expect(result.selfCalibration).toMatchObject({ agreedWithStructure: true, grade: 'accurate' })
  })
})

describe('summarizeDelegationCalibration', () => {
  function retro(grade: 'accurate' | 'over-delegated' | 'under-delegated' | 'unclear'): {
    delegation?: DelegationRetro
  } {
    return {
      delegation: {
        estimate: estimate(),
        outcome: {
          dispatchedTasks: 3,
          committedTasks: 1,
          noChangeTasks: 2,
          failedTasks: 0,
          observedPeakParallel: 1,
          multiAgentCandidates: 0,
          infraFailedTasks: 0
        },
        verdict: 'overhead',
        selfCalibration: { agreedWithStructure: false, grade, note: 'x' },
        note: 'x'
      }
    }
  }

  it('stays silent below the minimum run count', () => {
    const trend = summarizeDelegationCalibration([retro('over-delegated'), retro('over-delegated')])
    expect(trend.bias).toBeUndefined()
    expect(trend.hint).toBeUndefined()
  })

  it('flags a systematic over-delegation bias', () => {
    const trend = summarizeDelegationCalibration([
      retro('over-delegated'),
      retro('over-delegated'),
      retro('over-delegated'),
      retro('accurate')
    ])
    expect(trend.bias).toBe('over-delegating')
    expect(trend.hint).toContain('solo gereicht')
  })

  it('flags a systematic under-delegation bias', () => {
    const trend = summarizeDelegationCalibration([
      retro('under-delegated'),
      retro('under-delegated'),
      retro('under-delegated'),
      retro('accurate')
    ])
    expect(trend.bias).toBe('under-delegating')
    expect(trend.hint).toContain('delegieren')
  })

  it('ignores unclear grades and stays silent when well-calibrated', () => {
    const trend = summarizeDelegationCalibration([
      retro('accurate'),
      retro('accurate'),
      retro('accurate'),
      retro('unclear'),
      retro('over-delegated')
    ])
    expect(trend.runs).toBe(4)
    expect(trend.accurate).toBe(3)
    expect(trend.bias).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// P1.4 — multiagent fan-out vs. logical parent vs. real team
// ---------------------------------------------------------------------------

describe('toDelegationObservation classification', () => {
  it('separates logical parents, candidates and plain workers', () => {
    expect(
      toDelegationObservation({ status: 'running', multiAgentRunId: 'm1', createdAt: 0, finishedAt: 9 })
    ).toMatchObject({ multiAgentParent: true, multiAgentCandidate: false })
    expect(
      toDelegationObservation({
        status: 'success',
        multiAgentRunId: 'm1',
        multiAgentParentTaskId: 'p',
        multiAgentCandidate: 3
      })
    ).toMatchObject({ multiAgentParent: false, multiAgentCandidate: true })
    expect(toDelegationObservation({ status: 'success' })).toMatchObject({
      multiAgentParent: false,
      multiAgentCandidate: false
    })
    expect(
      toDelegationObservation({ status: 'error', failureKind: 'infrastructure' })
    ).toMatchObject({ failureKind: 'infrastructure' })
    expect(
      toDelegationObservation({ status: 'success', completion: { kind: 'commit' } })
    ).toMatchObject({ committed: true })
  })
})

describe('multiagent fan-out calibration (P1.4)', () => {
  const soloEstimate = estimate({ recommendation: 'solo', effectiveParallelWidth: 1, taskCount: 1 })

  function candidate(partial: Partial<DelegationTaskObservation> = {}): DelegationTaskObservation {
    return obs({ multiAgentCandidate: true, startedAt: 10, finishedAt: 150, ...partial })
  }

  it('1) a normal single-task solo run stays justified/solo', () => {
    const result = analyzeDelegation(soloEstimate, [
      obs({ committed: true, startedAt: 0, finishedAt: 20 })
    ])
    expect(result.verdict).toBe('justified')
    expect(result.outcome.dispatchedTasks).toBe(1)
    expect(result.outcome.multiAgentCandidates).toBe(0)
    expect(result.outcome.observedPeakParallel).toBe(1)
  })

  it('2) one logical task fanned out to five candidates is NOT solo overhead', () => {
    // Four losers report no changes, the reviewed winner commits.
    const candidates = [
      candidate({ committed: true }),
      candidate({ noChanges: true }),
      candidate({ noChanges: true }),
      candidate({ noChanges: true }),
      candidate({ noChanges: true })
    ]
    const result = analyzeDelegation(soloEstimate, candidates)
    expect(result.outcome.multiAgentCandidates).toBe(5)
    expect(result.verdict).not.toBe('overhead')
    expect(result.verdict).toBe('justified')
    expect(result.note).toContain('Multiagent-Wettbewerb')
  })

  it('3) five candidates plus the logical parent keep observedPeakParallel at 5, not 6', () => {
    const parent = obs({ multiAgentParent: true, startedAt: 0, finishedAt: 200 })
    const candidates = Array.from({ length: 5 }, () => candidate())
    const outcome = deriveDelegationOutcome([parent, ...candidates])

    expect(outcome.observedPeakParallel).toBe(5)
    expect(outcome.dispatchedTasks).toBe(5) // the logical parent is not a dispatched worker
    expect(outcome.multiAgentCandidates).toBe(5)
  })

  it('4) a shared infrastructure/transport wipeout is inconclusive, not over-delegated', () => {
    // Exactly the real run: every candidate died on the same prompt-transport bug.
    const candidates = Array.from({ length: 5 }, () =>
      candidate({ status: 'error', failureKind: 'infrastructure', finishedAt: 15 })
    )
    const result = analyzeDelegation(soloEstimate, candidates, selfEstimate({ recommendation: 'delegate' }))

    expect(result.outcome.infraFailedTasks).toBe(5)
    expect(result.verdict).toBe('inconclusive')
    // The orchestrator's delegate call must not be graded over-delegated here.
    expect(result.selfCalibration?.grade).toBe('unclear')
    expect(result.selfCalibration?.grade).not.toBe('over-delegated')
  })

  it('5) a genuine unnecessary team (distinct logical tasks) is still overhead', () => {
    // No candidates: three separate logical tasks spun up despite a solo need.
    const result = analyzeDelegation(soloEstimate, [
      obs({ committed: true }),
      obs({ noChanges: true }),
      obs({ noChanges: true })
    ])
    expect(result.outcome.multiAgentCandidates).toBe(0)
    expect(result.verdict).toBe('overhead')
  })

  it('grades a fan-out that produced an integrable winner as accurate, not over-delegated', () => {
    const candidates = [
      candidate({ committed: true }),
      candidate({ noChanges: true }),
      candidate({ status: 'stopped' })
    ]
    const result = analyzeDelegation(soloEstimate, candidates, selfEstimate({ recommendation: 'delegate' }))
    expect(result.selfCalibration?.grade).toBe('accurate')
  })
})
