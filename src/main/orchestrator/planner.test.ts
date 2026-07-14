import { describe, expect, it } from 'vitest'
import { resolveExecutionPlan } from './planner'
import { getOrchestratorAdapter } from './providerAdapters'
import type { McpServerHandle } from './mcpHandle'

const validPlan = {
  version: 1,
  goal: 'Ship a safe change',
  maxParallel: 2,
  tasks: [
    {
      id: 'inspect',
      title: 'Inspect',
      role: 'worker',
      prompt: 'Inspect the relevant files.',
      dependsOn: [],
      conflictKeys: ['src']
    },
    {
      id: 'verify',
      title: 'Verify',
      role: 'worker',
      prompt: 'Verify the result.',
      dependsOn: ['inspect'],
      conflictKeys: ['src']
    }
  ]
}

describe('auto subagent planner validation', () => {
  it('accepts a bounded acyclic plan without changing the valid-plan contract', () => {
    const result = resolveExecutionPlan(validPlan, 'worker', undefined, ['worker'])
    expect(result.usedFallback).toBe(false)
    expect(result.rejected).toBe(false)
    expect(result.issues).toEqual([])
    expect(result.plan.tasks).toHaveLength(2)
  })

  it('accepts an advisory audit that runs after the integrator', () => {
    const result = resolveExecutionPlan({
      ...validPlan,
      maxParallel: 3,
      tasks: [
        validPlan.tasks[0],
        {
          ...validPlan.tasks[1],
          id: 'integrate',
          title: 'Integrate',
          dependsOn: ['inspect'],
          ownership: 'integrator'
        },
        {
          ...validPlan.tasks[1],
          id: 'audit',
          title: 'Audit',
          dependsOn: [],
          advisoryDependsOn: ['integrate'],
          criticality: 'advisory'
        }
      ]
    })

    expect(result.usedFallback).toBe(false)
    expect(result.rejected).toBe(false)
    expect(result.issues).toEqual([])
  })

  it('rejects an integrator that omits a required feature dependency', () => {
    const result = resolveExecutionPlan({
      ...validPlan,
      tasks: [
        validPlan.tasks[0],
        {
          ...validPlan.tasks[1],
          id: 'integrate',
          title: 'Integrate',
          dependsOn: [],
          ownership: 'integrator'
        }
      ]
    })

    expect(result.rejected).toBe(true)
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'invalid_ownership', taskId: 'integrate' })
      ])
    )
  })

  it('still requires integrator ownership for shared hotspots', () => {
    const result = resolveExecutionPlan({
      ...validPlan,
      tasks: [
        {
          ...validPlan.tasks[0],
          expectedFiles: ['src/shared/orchestrator.ts']
        }
      ]
    })

    expect(result.rejected).toBe(true)
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'invalid_ownership', taskId: 'inspect' })
      ])
    )
  })

  it('marks a structured but invalid plan as rejected and preserves its issues', () => {
    const result = resolveExecutionPlan({ ...validPlan, version: 2, maxParallel: 0 })

    expect(result.usedFallback).toBe(true)
    expect(result.rejected).toBe(true)
    expect(result.issues).toHaveLength(2)
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'invalid_shape' }),
        expect.objectContaining({ code: 'invalid_parallelism' })
      ])
    )
  })

  it.each([
    null,
    'not a plan',
    {},
    { tasks: [] },
    { tasks: ['not a task object'] }
  ])('uses a non-rejected fallback for unparseable input %#', (input) => {
    const result = resolveExecutionPlan(input)

    expect(result.usedFallback).toBe(true)
    expect(result.rejected).toBe(false)
    expect(result.issues.length).toBeGreaterThan(0)
  })

  it('fails closed to one task for cycles or unknown roles', () => {
    const cycle = resolveExecutionPlan({
      ...validPlan,
      tasks: [
        { ...validPlan.tasks[0], id: 'a', dependsOn: ['b'] },
        { ...validPlan.tasks[1], id: 'b', dependsOn: ['a'] }
      ]
    })
    expect(cycle.usedFallback).toBe(true)
    expect(cycle.plan.tasks).toHaveLength(1)
    expect(cycle.issues.some((issue) => issue.code === 'dependency_cycle')).toBe(true)

    const unknownRole = resolveExecutionPlan(
      {
        ...validPlan,
        tasks: [{ ...validPlan.tasks[0], role: 'invented' }]
      },
      'worker',
      undefined,
      ['worker']
    )
    expect(unknownRole.usedFallback).toBe(true)
  })
})

describe('orchestrator provider adapters', () => {
  it('configures Codex through transient CLI overrides', () => {
    const handle: McpServerHandle = {
      url: 'http://127.0.0.1:1234/mcp',
      allowedTools: ['mcp__orca__execute_plan'],
      close: async () => undefined
    }
    const adapter = getOrchestratorAdapter('codex')
    const args = adapter.buildArgs({
      name: 'Gandalf',
      handle,
      configDir: '.',
      systemPrompt: 'Delegate work.'
    })
    expect(adapter.capability.supported).toBe(true)
    expect(args).toContain('developer_instructions="Delegate work."')
    expect(args).toContain('mcp_servers.orca.url="http://127.0.0.1:1234/mcp"')
    expect(args).toContain('mcp_servers.orca.enabled_tools=["execute_plan"]')
  })
})
