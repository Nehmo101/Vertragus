import { describe, expect, it } from 'vitest'
import { CURRENT_CONFIG_SCHEMA_VERSION, migrateConfigSnapshot } from './migrations'

describe('config migrations', () => {
  it('applies current profile defaults while preserving settings', () => {
    const result = migrateConfigSnapshot({
      schemaVersion: 0,
      profiles: [{ id: 'one', name: 'One', agents: [] }],
      activeProfileId: 'one',
      settings: { 'ui.theme': 'dark' }
    })
    expect(result.schemaVersion).toBe(CURRENT_CONFIG_SCHEMA_VERSION)
    expect(result.profiles[0].planner.mode).toBe('review')
    expect(result.profiles[0].autoGit).toEqual({ enabled: false, targetBranch: '' })
    expect(result.activeProfileId).toBe('one')
    expect(result.settings).toEqual({ 'ui.theme': 'dark' })
  })

  it('drops corrupt profiles and repairs the active profile reference', () => {
    const result = migrateConfigSnapshot({
      profiles: [null, { id: '', name: '' }],
      activeProfileId: '../missing',
      settings: []
    })
    expect(result.profiles).toHaveLength(1)
    expect(result.activeProfileId).toBe(result.profiles[0].id)
    expect(result.settings).toEqual({})
  })

  it('resets the shipped Fable default to the balanced Claude preset once', () => {
    const result = migrateConfigSnapshot({
      schemaVersion: 1,
      profiles: [
        {
          id: 'default',
          name: 'Fable + Codex subagents',
          workingDir: '',
          orchestrator: { provider: 'claude', model: 'fable', autoOpenSubwindows: true },
          agents: []
        },
        {
          id: 'custom',
          name: 'Intentional Fable',
          workingDir: '',
          orchestrator: { provider: 'claude', model: 'fable', autoOpenSubwindows: true },
          agents: []
        },
        {
          id: 'generated',
          name: 'Generated profile',
          workingDir: '',
          orchestrator: {
            provider: 'claude',
            model: 'fable',
            modelPreset: 'balanced',
            autoOpenSubwindows: true
          },
          agents: []
        }
      ],
      activeProfileId: 'default'
    })

    expect(result.profiles[0]).toMatchObject({
      name: 'Claude + Codex subagents',
      orchestrator: { model: '', modelPreset: 'balanced' }
    })
    expect(result.profiles[1].orchestrator?.model).toBe('fable')
    expect(result.profiles[1].orchestrator?.modelPreset).toBeUndefined()
    expect(result.profiles[2].orchestrator).toMatchObject({ model: '', modelPreset: 'balanced' })
  })

  it('preserves an enabled Auto-Git target while migrating older config snapshots', () => {
    const result = migrateConfigSnapshot({
      schemaVersion: 2,
      profiles: [{
        id: 'git-enabled',
        name: 'Git enabled',
        agents: [],
        autoGit: { enabled: true, targetBranch: 'orca/integrated' }
      }],
      activeProfileId: 'git-enabled'
    })

    expect(result.schemaVersion).toBe(3)
    expect(result.profiles[0].autoGit).toEqual({
      enabled: true,
      targetBranch: 'orca/integrated'
    })
  })
})
