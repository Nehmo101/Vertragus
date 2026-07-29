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

  it('folds the legacy tier preset into the model alias it expanded to', () => {
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

    // Stock default: the accidental Fable override goes, the balanced tier
    // becomes the rolling `sonnet` alias it always resolved to.
    expect(result.profiles[0]).toMatchObject({
      name: 'Claude + Codex subagents',
      orchestrator: { model: 'sonnet', effort: 'medium' }
    })
    // An intentional standalone Fable selection is preserved untouched.
    expect(result.profiles[1].orchestrator?.model).toBe('fable')
    expect(result.profiles[1].orchestrator?.effort).toBeUndefined()
    expect(result.profiles[2].orchestrator).toMatchObject({
      model: 'sonnet',
      effort: 'medium'
    })
  })

  it('keeps an explicit model and maps each legacy tier to an effort rung', () => {
    const result = migrateConfigSnapshot({
      schemaVersion: 3,
      profiles: [
        {
          id: 'legacy',
          name: 'Legacy tiers',
          workingDir: '',
          orchestrator: {
            provider: 'claude',
            model: 'claude-opus-4-7',
            modelPreset: 'strong',
            autoOpenSubwindows: true
          },
          agents: [
            { role: 'a', provider: 'codex', model: '', modelPreset: 'fast', count: 1, orchestrated: true, yolo: false },
            { role: 'b', provider: 'ollama', model: '', modelPreset: 'strong', count: 1, orchestrated: true, yolo: false }
          ]
        }
      ],
      activeProfileId: 'legacy'
    })

    // Explicit model wins, as it did before; only the tier moves to effort.
    expect(result.profiles[0].orchestrator).toMatchObject({
      model: 'claude-opus-4-7',
      effort: 'high'
    })
    expect(result.profiles[0].agents[0]).toMatchObject({ model: 'gpt-5.4-mini', effort: 'low' })
    expect(result.profiles[0].agents[1]).toMatchObject({
      model: 'llama3.3:70b',
      effort: 'high'
    })
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

    expect(result.schemaVersion).toBe(CURRENT_CONFIG_SCHEMA_VERSION)
    expect(result.profiles[0].autoGit).toEqual({
      enabled: true,
      targetBranch: 'orca/integrated'
    })
  })
})
