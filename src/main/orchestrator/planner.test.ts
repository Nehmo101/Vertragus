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
  it('accepts a bounded acyclic plan', () => {
    const result = resolveExecutionPlan(validPlan, 'worker', undefined, ['worker'])
    expect(result.usedFallback).toBe(false)
    expect(result.rejected).toBe(false)
    expect(result.issues).toEqual([])
    expect(result.plan.tasks).toHaveLength(2)
  })

  it('allows an advisory audit to run after the integrator', () => {
    const result = resolveExecutionPlan({
      ...validPlan,
      tasks: [
        {
          ...validPlan.tasks[0],
          id: 'feature',
          ownership: 'feature',
          criticality: 'required',
          expectedFiles: ['src/main/features/example.ts']
        },
        {
          ...validPlan.tasks[1],
          id: 'integrate',
          dependsOn: ['feature'],
          ownership: 'integrator',
          criticality: 'required',
          expectedFiles: ['src/shared/orchestrator.ts']
        },
        {
          ...validPlan.tasks[1],
          id: 'audit',
          dependsOn: [],
          advisoryDependsOn: ['integrate'],
          ownership: 'feature',
          criticality: 'advisory',
          expectedFiles: []
        }
      ]
    })

    expect(result.usedFallback).toBe(false)
    expect(result.rejected).toBe(false)
    expect(result.issues).toEqual([])
    expect(result.plan.tasks).toHaveLength(3)
  })

  it('rejects an integrator missing a required feature dependency', () => {
    const result = resolveExecutionPlan({
      ...validPlan,
      tasks: [
        {
          ...validPlan.tasks[0],
          id: 'feature',
          criticality: 'required'
        },
        {
          ...validPlan.tasks[1],
          id: 'integrate',
          dependsOn: [],
          ownership: 'integrator'
        }
      ]
    })

    expect(result.usedFallback).toBe(true)
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
          ownership: 'feature',
          expectedFiles: ['src/shared/orchestrator.ts']
        }
      ]
    })

    expect(result.usedFallback).toBe(true)
    expect(result.rejected).toBe(true)
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'invalid_ownership', taskId: 'inspect' })
      ])
    )
  })

  it('marks a structured but invalid plan as rejected and preserves its issues', () => {
    const result = resolveExecutionPlan({ ...validPlan, maxParallel: 0 })

    expect(result.usedFallback).toBe(true)
    expect(result.rejected).toBe(true)
    expect(result.plan.tasks).toHaveLength(1)
    expect(result.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'invalid_parallelism' })])
    )
  })

  it('uses a non-rejected fallback for unparseable input', () => {
    const inputs = [
      null,
      {},
      { ...validPlan, tasks: [] },
      { ...validPlan, tasks: ['not-a-task'] }
    ]

    for (const input of inputs) {
      const result = resolveExecutionPlan(input)
      expect(result.usedFallback).toBe(true)
      expect(result.rejected).toBe(false)
      expect(result.plan.tasks).toHaveLength(1)
      expect(result.issues.length).toBeGreaterThan(0)
    }
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
