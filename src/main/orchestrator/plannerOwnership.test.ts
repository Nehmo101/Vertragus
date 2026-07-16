import { describe, expect, it } from 'vitest'
import { resolveExecutionPlan } from './planner'

function plan(tasks: unknown[]): unknown {
  return { version: 1, goal: 'Integrate isolated work', maxParallel: 3, tasks }
}

const feature = {
  id: 'feature',
  title: 'Feature module',
  role: 'worker',
  prompt: 'Implement the isolated module and commit it.',
  dependsOn: [],
  conflictKeys: ['feature'],
  ownership: 'feature',
  expectedFiles: ['src/main/features/example.ts']
}

describe('planner shared hotspot ownership', () => {
  it('accepts one final integrator that owns shared files', () => {
    const result = resolveExecutionPlan(
      plan([
        feature,
        {
          id: 'integrate',
          title: 'Integrate shared contract',
          role: 'worker',
          prompt: 'Use dependency commits and update the shared contract.',
          dependsOn: ['feature'],
          conflictKeys: [],
          ownership: 'integrator',
          expectedFiles: ['src/shared/profile.ts', 'src/main/ipc/register.ts']
        }
      ]),
      'worker',
      undefined,
      ['worker']
    )

    expect(result.usedFallback).toBe(false)
    expect(result.plan.tasks[1]?.conflictKeys).toContain('shared-hotspots')
  })

  it('repairs shared-file feature ownership by serializing the writer instead of collapsing', () => {
    const sharedFeature = resolveExecutionPlan(
      plan([{ ...feature, expectedFiles: ['src/shared/orchestrator.ts'] }]),
      'worker',
      undefined,
      ['worker']
    )
    expect(sharedFeature.usedFallback).toBe(false)
    expect(sharedFeature.rejected).toBe(false)
    expect(sharedFeature.plan.tasks[0]?.conflictKeys).toContain('shared-hotspots')
    expect(sharedFeature.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'repaired_ownership', taskId: 'feature' })])
    )
  })

  it('repairs incomplete integrator dependencies with advisory edges instead of collapsing', () => {
    const incompleteIntegrator = resolveExecutionPlan(
      plan([
        feature,
        { ...feature, id: 'feature-2' },
        {
          ...feature,
          id: 'integrate',
          ownership: 'integrator',
          dependsOn: ['feature'],
          expectedFiles: ['src/renderer/src/styles.css']
        }
      ]),
      'worker',
      undefined,
      ['worker']
    )
    expect(incompleteIntegrator.usedFallback).toBe(false)
    const integrator = incompleteIntegrator.plan.tasks.find((task) => task.id === 'integrate')
    expect(integrator?.advisoryDependsOn).toContain('feature-2')
    expect(incompleteIntegrator.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'repaired_ownership', taskId: 'integrate' })])
    )
  })

  it('still collapses when the repair edge would close a dependency cycle', () => {
    const cyclic = resolveExecutionPlan(
      plan([
        { ...feature, dependsOn: ['integrate'] },
        {
          ...feature,
          id: 'integrate',
          ownership: 'integrator',
          dependsOn: [],
          expectedFiles: ['src/shared/profile.ts']
        }
      ]),
      'worker',
      undefined,
      ['worker']
    )
    expect(cyclic.usedFallback).toBe(true)
    expect(cyclic.rejected).toBe(true)
    expect(cyclic.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'invalid_ownership', taskId: 'integrate' })])
    )
  })

  it('still collapses plans with more than one integrator', () => {
    const twoIntegrators = resolveExecutionPlan(
      plan([
        feature,
        { ...feature, id: 'integrate-a', ownership: 'integrator', dependsOn: ['feature'] },
        { ...feature, id: 'integrate-b', ownership: 'integrator', dependsOn: ['feature'] }
      ]),
      'worker',
      undefined,
      ['worker']
    )
    expect(twoIntegrators.usedFallback).toBe(true)
    expect(twoIntegrators.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'invalid_ownership' })])
    )
  })
})
