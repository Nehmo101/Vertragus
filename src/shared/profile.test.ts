import { describe, expect, it } from 'vitest'
import { agentSlotsWithRoles, DEFAULT_PROFILE, workspaceProfileSchema } from './profile'

describe('workspaceProfileSchema', () => {
  it('migrates legacy profiles with planner and Auto-PR defaults', () => {
    const profile = workspaceProfileSchema.parse({
      id: 'legacy',
      name: 'Legacy',
      workingDir: '',
      orchestrator: { provider: 'codex', model: '', autoOpenSubwindows: true },
      agents: [],
      yoloDefault: false
    })
    expect(profile.planner.mode).toBe('review')
    expect(profile.autoPr.mode).toBe('off')
    expect(profile.orchestrator?.model).toBe('')
  })

  it('keeps the default profile valid', () => {
    expect(workspaceProfileSchema.parse(DEFAULT_PROFILE)).toEqual(DEFAULT_PROFILE)
  })

  it('assigns the same stable unique role keys used by team start and dispatch', () => {
    const slots = [
      { role: 'Worker', provider: 'codex' as const, model: '', count: 2, orchestrated: true, yolo: false },
      { role: 'Worker', provider: 'cursor' as const, model: 'composer', count: 1, orchestrated: true, yolo: false },
      { role: 'Review', provider: 'claude' as const, model: 'sonnet', count: 1, orchestrated: true, yolo: false }
    ]

    expect(agentSlotsWithRoles(slots).map(({ role }) => role)).toEqual([
      'worker',
      'worker-2',
      'review'
    ])
    expect(
      agentSlotsWithRoles([
        { ...slots[0], orchestrated: false },
        slots[1]
      ])
        .filter(({ slot }) => slot.orchestrated)
        .map(({ role }) => role)
    ).toEqual(['worker-2'])
  })
})
