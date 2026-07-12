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
    expect(result.plan.tasks).toHaveLength(2)
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
