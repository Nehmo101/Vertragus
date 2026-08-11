import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptyProfile } from '@shared/schema/profile'
import { providerConfigSchema } from '@shared/schema/provider'
import { providerPresets } from '@main/providers/presets'
import {
  adoptLegacyStore,
  appSettingsSchema,
  createSettingsStore,
  LEGACY_STORE_NAME,
  SETTINGS_KEYS,
  STORE_NAME,
  type SettingsBackend,
  type SettingsStore
} from './settings'

/** In-memory backend — the real store is never constructed in a unit test. */
function memoryBackend(seed: Record<string, unknown> = {}): SettingsBackend & {
  data: Record<string, unknown>
} {
  const data: Record<string, unknown> = { ...seed }
  return {
    data,
    get: (key) => data[key],
    set: (key, value) => {
      // Round-trip through JSON like a real file-backed store would.
      data[key] = JSON.parse(JSON.stringify(value))
    }
  }
}

const validProfile = {
  id: 'p1',
  name: 'Vertragus',
  repoPath: 'C:/git/vertragus',
  orchestrator: { providerId: 'claude' },
  slots: []
}

let warn: ReturnType<typeof vi.fn>

function store(seed: Record<string, unknown> = {}): {
  store: SettingsStore
  backend: ReturnType<typeof memoryBackend>
} {
  const backend = memoryBackend(seed)
  return { backend, store: createSettingsStore({ backend, warn }) }
}

beforeEach(() => {
  warn = vi.fn()
})

describe('profiles', () => {
  it('starts empty and round-trips a saved profile', () => {
    const { store: settings, backend } = store()
    expect(settings.getProfiles()).toEqual([])
    const saved = settings.saveProfile(validProfile)
    expect(saved).toHaveLength(1)
    expect(settings.getProfile('p1')?.name).toBe('Vertragus')
    expect(backend.data.profiles).toHaveLength(1)
  })

  it('updates in place instead of appending a twin', () => {
    const { store: settings } = store()
    settings.saveProfile(validProfile)
    const updated = settings.saveProfile({ ...validProfile, name: 'Renamed' })
    expect(updated).toHaveLength(1)
    expect(updated[0]!.name).toBe('Renamed')
  })

  it('rejects an invalid profile on WRITE (a caller bug must be visible)', () => {
    const { store: settings } = store()
    expect(() => settings.saveProfile({ ...validProfile, name: '' })).toThrow()
    expect(settings.getProfiles()).toEqual([])
  })

  it('drops an invalid row on READ and keeps the rest', () => {
    const { store: settings } = store({
      profiles: [validProfile, { id: 'broken' }, { ...validProfile, id: 'p2', maxSubagents: 999 }]
    })
    expect(settings.getProfiles().map((profile) => profile.id)).toEqual(['p1'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dropped 2 invalid profile'))
  })

  it('survives a corrupt profiles section entirely', () => {
    const { store: settings } = store({ profiles: 'not-an-array' })
    expect(settings.getProfiles()).toEqual([])
  })

  it('deletes by id without touching the others', () => {
    const { store: settings } = store()
    settings.saveProfile(validProfile)
    settings.saveProfile({ ...validProfile, id: 'p2', name: 'Second' })
    expect(settings.deleteProfile('p1').map((profile) => profile.id)).toEqual(['p2'])
    expect(settings.deleteProfile('ghost')).toHaveLength(1)
  })

  it('accepts a generated empty profile', () => {
    const { store: settings } = store()
    expect(settings.saveProfile(createEmptyProfile({ name: 'Fresh' }))).toHaveLength(1)
  })
})

describe('providers', () => {
  const presetIds = providerPresets().map((preset) => preset.id)

  it('exposes the presets when nothing is stored', () => {
    const { store: settings } = store()
    expect(settings.getProviders()).toEqual([])
    expect(settings.effectiveProviders().map((provider) => provider.id)).toEqual(presetIds)
  })

  it('lets a stored override win over its preset', () => {
    const { store: settings } = store()
    settings.saveProvider({
      id: 'claude',
      presetId: 'claude',
      label: 'Claude Code (mine)',
      command: 'claude',
      yoloArgs: []
    })
    const effective = settings.effectiveProviders()
    expect(effective.map((provider) => provider.id)).toEqual(presetIds)
    const claude = effective.find((provider) => provider.id === 'claude')!
    expect(claude.label).toBe('Claude Code (mine)')
    expect(claude.yoloArgs).toEqual([])
  })

  it('restores the preset when the override is deleted (reset to preset)', () => {
    const { store: settings } = store()
    settings.saveProvider({ id: 'claude', label: 'Mine', command: 'claude' })
    settings.deleteProvider('claude')
    const claude = settings.effectiveProviders().find((provider) => provider.id === 'claude')!
    expect(claude.label).toBe('Claude Code')
    expect(claude.yoloArgs).toEqual(['--dangerously-skip-permissions'])
  })

  it('appends a custom provider after the presets', () => {
    const { store: settings } = store()
    settings.saveProvider({ id: 'acme', label: 'Acme', command: 'acme' })
    expect(settings.effectiveProviders().at(-1)).toMatchObject({ id: 'acme' })
  })

  it('drops an invalid stored provider on read', () => {
    const { store: settings } = store({
      providers: [{ id: 'acme', label: 'Acme', command: 'acme' }, { id: 'broken' }]
    })
    expect(settings.getProviders().map((provider) => provider.id)).toEqual(['acme'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('invalid provider config'))
  })

  it('rejects an invalid provider on write', () => {
    const { store: settings } = store()
    expect(() => settings.saveProvider({ id: 'acme', label: 'Acme' })).toThrow()
  })

  it('keeps the stored entry parseable by the shared schema', () => {
    const { store: settings, backend } = store()
    settings.saveProvider({ id: 'acme', label: 'Acme', command: 'acme' })
    const [stored] = backend.data.providers as unknown[]
    expect(providerConfigSchema.safeParse(stored).success).toBe(true)
  })
})

describe('role templates', () => {
  it('stores only custom templates; the built-ins live in code', () => {
    const { store: settings } = store()
    expect(settings.getRoleTemplates()).toEqual([])
    settings.saveRoleTemplate({ id: 'sre', name: 'SRE', prompt: 'Keep it running.' })
    expect(settings.getRoleTemplates()).toEqual([
      { id: 'sre', name: 'SRE', prompt: 'Keep it running.', builtin: false }
    ])
    expect(settings.deleteRoleTemplate('sre')).toEqual([])
  })

  it('drops invalid and duplicate templates on read', () => {
    const { store: settings } = store({
      roleTemplates: [
        { id: 'sre', name: 'SRE', prompt: 'p' },
        { id: 'sre', name: 'Duplicate', prompt: 'p' },
        { id: 'bad' }
      ]
    })
    expect(settings.getRoleTemplates().map((template) => template.name)).toEqual(['SRE'])
  })
})

describe('app settings', () => {
  it('serves the documented defaults on a fresh store', () => {
    const { store: settings } = store()
    expect(settings.getSettings()).toEqual({
      ui: { theme: 'dark', locale: 'de' },
      yoloMaster: true,
      hideAllHotkey: 'Control+Alt+V',
      autostart: false,
      updateChannel: 'main',
      modelMemory: {}
    })
  })

  it('switches the update channel and refuses an invented one', () => {
    const { store: settings, backend } = store()
    expect(settings.setSetting('updateChannel', 'stable').updateChannel).toBe('stable')
    expect(backend.data.updateChannel).toBe('stable')
    // @ts-expect-error — IPC input is not type-checked; the schema is the gate.
    expect(() => settings.setSetting('updateChannel', 'nightly')).toThrow()
  })

  it('writes theme and autostart through the same single-key path', () => {
    const { store: settings } = store()
    settings.setSetting('autostart', true)
    settings.setSetting('ui', { theme: 'light', locale: 'en' })
    const result = settings.getSettings()
    expect(result.autostart).toBe(true)
    expect(result.ui.theme).toBe('light')
    expect(result.yoloMaster).toBe(true)
  })

  it('writes and reads a single key without disturbing the others', () => {
    const { store: settings, backend } = store()
    const next = settings.setSetting('yoloMaster', false)
    expect(next.yoloMaster).toBe(false)
    expect(next.hideAllHotkey).toBe('Control+Alt+V')
    expect(backend.data.yoloMaster).toBe(false)
  })

  it('persists the panel position and the locale', () => {
    const { store: settings } = store()
    settings.setSetting('ui', { theme: 'dark', locale: 'en', panelBounds: { edge: 'right', y: 320 } })
    expect(settings.getSettings().ui).toEqual({
      theme: 'dark',
      locale: 'en',
      panelBounds: { edge: 'right', y: 320 }
    })
  })

  it('rejects an invalid value on write', () => {
    const { store: settings } = store()
    // An empty accelerator type-checks but can never be registered.
    expect(() => settings.setSetting('hideAllHotkey', '')).toThrow()
    // @ts-expect-error — the typed API stops this at compile time; the schema
    // stops it at runtime, because IPC input is not type-checked.
    expect(() => settings.setSetting('ui', { theme: 'neon' })).toThrow()
  })

  it('repairs a single corrupt key and keeps the valid ones', () => {
    const { store: settings } = store({
      yoloMaster: 'yes-please',
      hideAllHotkey: 'Control+Shift+H',
      ui: { theme: 'light', locale: 'en' }
    })
    const result = settings.getSettings()
    expect(result.yoloMaster).toBe(true)
    expect(result.hideAllHotkey).toBe('Control+Shift+H')
    expect(result.ui).toEqual({ theme: 'light', locale: 'en' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('invalid settings section'))
  })

  it('round-trips the model memory discovery persists', () => {
    const { store: settings } = store()
    settings.setSetting('modelMemory', { claude: { opus: 1_800_000_000_000 } })
    expect(settings.getSettings().modelMemory).toEqual({ claude: { opus: 1_800_000_000_000 } })
  })

  it('rejects an empty update channel like any other invalid value', () => {
    const { store: settings } = store({ updateChannel: 'nightly' })
    // Fail-soft on read: the bad key falls back, the good ones survive.
    expect(settings.getSettings().updateChannel).toBe('main')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('invalid settings section'))
  })

  it('covers every settings key with a schema field', () => {
    for (const key of SETTINGS_KEYS) {
      expect(appSettingsSchema.shape[key]).toBeDefined()
    }
    expect(Object.keys(appSettingsSchema.shape).sort()).toEqual([...SETTINGS_KEYS].sort())
  })
})

describe('the store file name', () => {
  /**
   * The bug this guards: the archived app is also called "vertragus", so both
   * apps used %APPDATA%\vertragus\vertragus.json. Every boot of this app read
   * seven foreign profiles, dropped them all, and wrote its own over them.
   */
  it('is vertragus-v2, never the archived app’s vertragus', () => {
    expect(STORE_NAME).toBe('vertragus-v2')
    expect(LEGACY_STORE_NAME).toBe('vertragus')
    expect(STORE_NAME).not.toBe(LEGACY_STORE_NAME)
  })
})

describe('adoptLegacyStore', () => {
  it('takes over what the shared file holds in the CURRENT format', () => {
    const adopted = adoptLegacyStore({
      profiles: [validProfile],
      providers: [{ id: 'acme', label: 'Acme', command: 'acme' }],
      roleTemplates: [{ id: 'sre', name: 'SRE', prompt: 'Keep it running.' }],
      hideAllHotkey: 'Control+Shift+H',
      updateChannel: 'stable',
      ui: { theme: 'light', locale: 'en' }
    })

    expect((adopted.profiles as unknown[])).toHaveLength(1)
    expect((adopted.providers as { id: string }[])[0]!.id).toBe('acme')
    expect((adopted.roleTemplates as unknown[])).toHaveLength(1)
    expect(adopted.hideAllHotkey).toBe('Control+Shift+H')
    expect(adopted.updateChannel).toBe('stable')
    expect(adopted.ui).toEqual({ theme: 'light', locale: 'en' })
  })

  it('leaves the archived app’s own records behind instead of dropping them loudly', () => {
    // Exactly the seven rows that used to be "dropped" on every boot: a shape
    // this schema has never understood.
    const adopted = adoptLegacyStore({
      profiles: [{ id: 'old-1', title: 'Legacy', agents: [{ kind: 'claude' }] }],
      providers: [{ id: 'old', binary: 'claude' }],
      settings: { theme: 'midnight' }
    })
    expect(adopted).toEqual({})
  })

  it('adopts the valid rows of a mixed file and skips the rest', () => {
    const adopted = adoptLegacyStore({
      profiles: [validProfile, { id: 'old-1', title: 'Legacy' }],
      yoloMaster: 'yes-please',
      autostart: true
    })
    expect((adopted.profiles as { id: string }[]).map((entry) => entry.id)).toEqual(['p1'])
    expect(adopted.yoloMaster).toBeUndefined()
    expect(adopted.autostart).toBe(true)
  })

  it('writes nothing at all for a missing, empty or hostile file', () => {
    expect(adoptLegacyStore(undefined)).toEqual({})
    expect(adoptLegacyStore(null)).toEqual({})
    expect(adoptLegacyStore('not-an-object')).toEqual({})
    expect(adoptLegacyStore([1, 2, 3])).toEqual({})
    expect(adoptLegacyStore({})).toEqual({})
  })

  it('produces exactly what the store then reads back', () => {
    const adopted = adoptLegacyStore({ profiles: [validProfile], updateChannel: 'stable' })
    const { store: settings } = store(adopted)
    expect(settings.getProfiles().map((profile) => profile.id)).toEqual(['p1'])
    expect(settings.getSettings().updateChannel).toBe('stable')
    expect(warn).not.toHaveBeenCalled()
  })
})
