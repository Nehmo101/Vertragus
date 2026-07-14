import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '.' } }))
vi.mock('@main/orchestrator/mcpHandle', () => ({ getMcpHandle: () => null }))
vi.mock('@main/orchestrator/externalMcp', () => ({ externalMcpSpecsFor: () => [] }))
vi.mock('@main/orchestrator/promptOverlay', () => ({ getPromptOverlay: vi.fn(() => undefined) }))

import { orchestratorSystemPrompt } from './orchestratorLaunch'

describe('orchestrator progress communication prompt', () => {
  it('requires detailed, truthful updates for coordinator and named workers', () => {
    const prompt = orchestratorSystemPrompt('Gandalf')

    expect(prompt).toContain('report_activity')
    expect(prompt).toContain('exact agentName returned by list_tasks/get_task_status')
    expect(prompt).toContain('never infer or invent a worker name')
    expect(prompt).toContain('was du selbst gerade')
    expect(prompt).toContain('Subagent-Name')
    expect(prompt).toContain('aktueller Aktion und Blocker')
    expect(prompt).toContain('Nächster Schritt')
    expect(prompt).toContain('erfinde keinen Fortschritt')
  })

  it('injects the learnings overlay between retro block and role rules', () => {
    const overlay = '- Bevorzuge kleine, fokussierte Pläne.\n- UI-Aufgaben an Modell X delegieren.'
    const prompt = orchestratorSystemPrompt('Gandalf', { overlayText: overlay })

    expect(prompt).toContain('Gelerntes Teamwissen')
    expect(prompt).toContain(overlay)
    const overlayAt = prompt.indexOf('Gelerntes Teamwissen')
    expect(overlayAt).toBeGreaterThan(prompt.indexOf('Retrospektive und Modellwissen'))
    expect(overlayAt).toBeLessThan(prompt.indexOf('Rollen und Ausführung:'))
  })

  it('emits no overlay section without overlay text', () => {
    expect(orchestratorSystemPrompt('Gandalf')).not.toContain('Gelerntes Teamwissen')
    expect(orchestratorSystemPrompt('Gandalf', { overlayText: '' })).not.toContain(
      'Gelerntes Teamwissen'
    )
  })

  it('requires adaptive plan-first routing and a terminal success-or-dead-end loop', () => {
    const prompt = orchestratorSystemPrompt('Gandalf', { adaptiveTeam: true, maxRetries: 2 })

    expect(prompt).toContain('Zu Beginn läuft nur der Orchestrator')
    expect(prompt).toContain('Nicht ausgewählte Agents bleiben ausgeschaltet')
    expect(prompt).toContain('Reiche auch Ein-Task-Pläne über execute_plan ein')
    expect(prompt).toContain('fokussierten Folgeplan')
    expect(prompt).toContain('konkrete Sackgasse')
    expect(prompt).toContain('höchstens 2 Re-Plan-Versuch')
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
