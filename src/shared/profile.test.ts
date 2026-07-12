import { describe, expect, it } from 'vitest'
import { DEFAULT_PROFILE, workspaceProfileSchema } from './profile'

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
})
