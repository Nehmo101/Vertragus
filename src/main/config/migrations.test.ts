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
})
