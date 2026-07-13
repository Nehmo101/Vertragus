import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '.' } }))
vi.mock('@main/orchestrator/mcpHandle', () => ({ getMcpHandle: () => null }))
vi.mock('@main/orchestrator/externalMcp', () => ({ externalMcpSpecsFor: () => [] }))

import { orchestratorSystemPrompt } from './orchestratorLaunch'

describe('orchestrator worker identity prompt', () => {
  it('grounds worker names in task status instead of inventing them', () => {
    const prompt = orchestratorSystemPrompt('Gandalf')

    expect(prompt).toContain('exact agentName returned by list_tasks/get_task_status')
    expect(prompt).toContain('taskId and role')
    expect(prompt).toContain('never infer or invent a worker name')
  })

  it('requires detailed, truthful updates for coordinator and named workers', () => {
    const prompt = orchestratorSystemPrompt('Gandalf')

    expect(prompt).toContain('report_activity')
    expect(prompt).toContain('was du selbst gerade')
    expect(prompt).toContain('Subagent-Name')
    expect(prompt).toContain('aktueller Aktion und Blocker')
    expect(prompt).toContain('Nächster Schritt')
    expect(prompt).toContain('erfinde keinen Fortschritt')
  })
})
