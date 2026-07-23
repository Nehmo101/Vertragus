import { describe, expect, it } from 'vitest'
import { resolveExecutionPlan } from './planner'
import { orchestratorTrainingScenarios } from '@shared/__fixtures__/orchestratorTraining'

describe('orchestrator training catalogue', () => {
  it('exposes a non-empty catalogue with unique ids', () => {
    expect(orchestratorTrainingScenarios.length).toBeGreaterThan(0)
    const ids = orchestratorTrainingScenarios.map((scenario) => scenario.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('covers the full range from few to many subagents', () => {
    const sizes = new Set(orchestratorTrainingScenarios.map((scenario) => scenario.teamSize))
    expect(sizes.has('solo')).toBe(true)
    expect(sizes.has('large')).toBe(true)
  })

  it('keeps a well-formed first scenario', () => {
    const first = orchestratorTrainingScenarios[0]
    expect(first).toBeDefined()
    expect(first.id.length).toBeGreaterThan(0)
  })

  it('only omits a reference plan for benchmark-mode scenarios', () => {
    for (const scenario of orchestratorTrainingScenarios) {
      if (scenario.mode === 'run_benchmark') {
        expect(scenario.referencePlan).toBeUndefined()
      } else {
        expect(scenario.referencePlan).toBeDefined()
      }
    }
  })

  for (const scenario of orchestratorTrainingScenarios) {
    const plan = scenario.referencePlan
    if (!plan) continue

    it(`reference plan "${scenario.id}" passes the real plan validator without fallback`, () => {
      const result = resolveExecutionPlan(plan, 'worker', undefined, scenario.roles)
      expect(result.issues).toHaveLength(0)
      expect(result.usedFallback).toBe(false)
      expect(result.plan.tasks).toHaveLength(plan.tasks.length)
    })

    it(`reference plan "${scenario.id}" only uses roles from its declared pool`, () => {
      const pool = new Set(scenario.roles.map((role) => role.toLowerCase()))
      for (const task of plan.tasks) {
        expect(pool.has(task.role.toLowerCase())).toBe(true)
      }
    })

    it(`reference plan "${scenario.id}" keeps at most one integrator`, () => {
      const integrators = plan.tasks.filter((task) => task.ownership === 'integrator')
      expect(integrators.length).toBeLessThanOrEqual(1)
    })
  }
})
