import { describe, expect, it } from 'vitest'
import { estimatePlanDelegation } from './planEstimate'
import type { ExecutionPlan, ExecutionPlanTask } from './orchestrator'
import { orchestratorTrainingScenarios } from './orchestratorTraining'

function task(partial: Partial<ExecutionPlanTask> & { id: string }): ExecutionPlanTask {
  return {
    title: partial.id,
    role: 'coder',
    prompt: 'do it',
    dependsOn: [],
    advisoryDependsOn: [],
    criticality: 'required',
    conflictKeys: [partial.id],
    ownership: 'feature',
    expectedFiles: [],
    ...partial
  }
}

function plan(tasks: ExecutionPlanTask[], maxParallel = tasks.length): ExecutionPlan {
  return { version: 1, goal: 'test goal', maxParallel, tasks }
}

describe('estimatePlanDelegation', () => {
  it('recommends solo for a single-task plan', () => {
    const estimate = estimatePlanDelegation(plan([task({ id: 'only' })], 1))
    expect(estimate.recommendation).toBe('solo')
    expect(estimate.effectiveParallelWidth).toBe(1)
    expect(estimate.underParallelized).toBe(false)
    expect(estimate.reason).toContain('kein Subagent-Team')
  })

  it('keeps a single logical task structurally solo even with maxParallel=1 (multiagent fan-out is a runtime concern)', () => {
    // A single logical task whose multiagent mode fans it out into five competing
    // candidates is still structurally solo: maxParallel=1 stays correct, and the
    // fan-out is measured on the run outcome (multiAgentCandidates), not here.
    const estimate = estimatePlanDelegation(plan([task({ id: 'logical' })], 1))
    expect(estimate.recommendation).toBe('solo')
    expect(estimate.taskCount).toBe(1)
    expect(estimate.effectiveParallelWidth).toBe(1)
    expect(estimate.declaredMaxParallel).toBe(1)
  })

  it('recommends solo for a purely serial multi-task plan', () => {
    const estimate = estimatePlanDelegation(
      plan(
        [
          task({ id: 'impl' }),
          task({ id: 'test', dependsOn: ['impl'] })
        ],
        1
      )
    )
    expect(estimate.recommendation).toBe('solo')
    expect(estimate.parallelWidth).toBe(1)
    expect(estimate.effectiveParallelWidth).toBe(1)
  })

  it('recommends delegate for independent parallel tasks', () => {
    const estimate = estimatePlanDelegation(
      plan([task({ id: 'a' }), task({ id: 'b' }), task({ id: 'c' })], 3)
    )
    expect(estimate.recommendation).toBe('delegate')
    expect(estimate.effectiveParallelWidth).toBe(3)
    expect(estimate.underParallelized).toBe(false)
  })

  it('collapses tasks that share a conflictKey into one concurrency slot', () => {
    const estimate = estimatePlanDelegation(
      plan(
        [
          task({ id: 'a', conflictKeys: ['shared'] }),
          task({ id: 'b', conflictKeys: ['shared'] })
        ],
        2
      )
    )
    // Both touch the same resource, so they cannot truly run at once.
    expect(estimate.parallelWidth).toBe(2)
    expect(estimate.effectiveParallelWidth).toBe(1)
    expect(estimate.recommendation).toBe('solo')
  })

  it('flags under-parallelization when maxParallel needlessly serializes', () => {
    const estimate = estimatePlanDelegation(
      plan([task({ id: 'a' }), task({ id: 'b' }), task({ id: 'c' })], 1)
    )
    expect(estimate.recommendation).toBe('delegate')
    expect(estimate.effectiveParallelWidth).toBe(3)
    expect(estimate.underParallelized).toBe(true)
    expect(estimate.reason).toContain('maxParallel')
  })

  it('treats an advisory reviewer that waits on features as a later layer (solo)', () => {
    // One feature + one advisory review that waits for it: no concurrency.
    const estimate = estimatePlanDelegation(
      plan(
        [
          task({ id: 'feature' }),
          task({
            id: 'review',
            role: 'reviewer',
            criticality: 'advisory',
            advisoryDependsOn: ['feature'],
            conflictKeys: ['review-only']
          })
        ],
        1
      )
    )
    expect(estimate.effectiveParallelWidth).toBe(1)
    expect(estimate.recommendation).toBe('solo')
  })

  it('counts the integrator funnel structurally without inflating width', () => {
    const estimate = estimatePlanDelegation(
      plan(
        [
          task({ id: 'export' }),
          task({ id: 'import' }),
          task({
            id: 'integrate',
            dependsOn: ['export', 'import'],
            ownership: 'integrator',
            conflictKeys: []
          })
        ],
        2
      )
    )
    expect(estimate.hasIntegrator).toBe(true)
    expect(estimate.effectiveParallelWidth).toBe(2) // export + import run together; integrator waits
    expect(estimate.recommendation).toBe('delegate')
  })
})

// Cross-check against the shipped orchestrator training reference plans so the
// estimate stays aligned with the catalog's right-sizing intent.
describe('estimatePlanDelegation on training reference plans', () => {
  const expectations: Record<string, DelegationRecommendation> = {
    'solo-readme-typo': 'solo',
    'solo-flaky-test': 'solo',
    'small-util-plus-test': 'solo', // impl -> test is serial: one agent suffices
    'small-profile-field': 'solo', // ui -> integrator is serial
    'medium-three-independent-modules': 'delegate',
    'medium-new-mcp-tool': 'delegate',
    'large-workspace-refresh': 'delegate',
    'large-layered-pipeline': 'delegate',
    'trap-shared-schema-collision': 'delegate'
  }

  for (const scenario of orchestratorTrainingScenarios) {
    if (!scenario.referencePlan) continue
    const expected = expectations[scenario.id]
    if (!expected) continue
    it(`${scenario.id} -> ${expected}`, () => {
      expect(estimatePlanDelegation(scenario.referencePlan!).recommendation).toBe(expected)
    })
  }
})

type DelegationRecommendation = 'solo' | 'delegate'
