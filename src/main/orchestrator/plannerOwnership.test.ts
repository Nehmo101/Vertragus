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

  it('rejects shared-file feature ownership and incomplete integrator dependencies', () => {
    const sharedFeature = resolveExecutionPlan(
      plan([{ ...feature, expectedFiles: ['src/shared/orchestrator.ts'] }]),
      'worker',
      undefined,
      ['worker']
    )
    expect(sharedFeature.usedFallback).toBe(true)
    expect(sharedFeature.issues.some((issue) => issue.code === 'invalid_ownership')).toBe(true)

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
    expect(incompleteIntegrator.usedFallback).toBe(true)
    expect(incompleteIntegrator.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'invalid_ownership', taskId: 'integrate' })])
    )
  })
})
