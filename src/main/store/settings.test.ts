import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_APPEARANCE } from '@shared/appearance'
import { createEmptyProfile } from '@shared/schema/profile'
import { providerConfigSchema } from '@shared/schema/provider'
import { providerPresets } from '@main/providers/presets'
import {
  adoptLegacyStore,
  appSettingsSchema,
  createSettingsStore,
  defaultLocaleForOs,
  effectiveAgentPolicy,
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

  /**
   * Real data flow that used to lose every hand-drawn layout:
   * zone overlay saves zones → profile editor (opened earlier) saves without
   * `zones` → store must still hold the layout, or agent windows fall back to
   * auto-tiling as if no zones existed.
   */
  it('keeps zones when a later profile save omits them', () => {
    const { store: settings } = store()
    const zones = {
      zones: [{ roleId: 'worker', displayId: 1, rect: { x: 0, y: 0, w: 0.5, h: 1 } }]
    }
    settings.saveProfile(validProfile)
    settings.saveProfile({ ...validProfile, zones })
    settings.saveProfile(validProfile)
    expect(settings.getProfile('p1')!.zones).toEqual(zones)
  })

  it('still lets an explicit empty zone layout clear what was stored', () => {
    const { store: settings } = store()
    settings.saveProfile({
      ...validProfile,
      zones: { zones: [{ roleId: 'worker', displayId: 1, rect: { x: 0, y: 0, w: 1, h: 1 } }] }
    })
    settings.saveProfile({ ...validProfile, zones: { zones: [] } })
    expect(settings.getProfile('p1')!.zones).toEqual({ zones: [] })
  })

  it('E6: keeps a slot’s extraMcp when a form save omits it; [] clears it', () => {
    const { store: settings } = store()
    const slot = { id: 's1', roleId: 'worker', providerId: 'claude' }
    const extraMcp = [{ name: 'browser', url: 'http://127.0.0.1:9200/mcp' }]
    settings.saveProfile({ ...validProfile, slots: [{ ...slot, extraMcp }] })
    // The profile editor has no extraMcp field — its save must not wipe it.
    settings.saveProfile({ ...validProfile, slots: [slot] })
    expect(settings.getProfile('p1')!.slots[0]!.extraMcp).toEqual(extraMcp)
    // An explicit empty list is the deliberate clear.
    settings.saveProfile({ ...validProfile, slots: [{ ...slot, extraMcp: [] }] })
    expect(settings.getProfile('p1')!.slots[0]!.extraMcp).toEqual([])
  })

  it('zone → profile-save → placeAgentWindow still lands inside the zone', async () => {
    const { placeAgentWindow } = await import('@main/windows/placement')
    const { store: settings } = store()
    const zones = {
      zones: [{ roleId: 'worker', displayId: 1, rect: { x: 0.5, y: 0, w: 0.5, h: 1 } }]
    }
    settings.saveProfile(validProfile)
    settings.saveProfile({ ...validProfile, zones })
    // Stale profile-editor draft (no zones field) — used to wipe the layout.
    settings.saveProfile({ ...validProfile, name: 'Vertragus' })
    const profile = settings.getProfile('p1')!
    const bounds = placeAgentWindow({
      profile,
      roleId: 'worker',
      displays: [{ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 }, primary: true }]
    })
    expect(bounds).toEqual({ x: 960, y: 0, width: 960, height: 1080 })
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
      ui: {
        theme: 'dark',
        locale: 'de',
        appearance: DEFAULT_APPEARANCE,
        reflowNeighbors: true,
        onboardingDismissed: false
      },
      remote: { enabled: false, bindAddress: '', port: 9482 },
      yoloMaster: true,
      piHarnessEnabled: false,
      hideAllHotkey: 'Control+Alt+V',
      autostart: false,
      updateChannel: 'main',
      modelMemory: {},
      voice: {
        enabled: false,
        wakePhrase: 'Hey Vertragus',
        apiKey: '',
        openaiApiKey: '',
        provider: 'xai',
        voiceId: 'eve',
        inputDeviceId: '',
        outputDeviceId: ''
      },
      mcpServers: []
    })
  })

  it('defaults reflowNeighbors to true when ui is missing', () => {
    const { store: settings } = store({ hideAllHotkey: 'Control+Shift+H' })
    expect(settings.getSettings().ui.reflowNeighbors).toBe(true)
    expect(settings.getSettings().hideAllHotkey).toBe('Control+Shift+H')
  })

  it('keeps the voice assistant off until the user turns it on', () => {
    const { store: settings } = store()
    expect(settings.getSettings().voice.enabled).toBe(false)
    expect(settings.getSettings().voice.wakePhrase).toBe('Hey Vertragus')
    expect(settings.getSettings().voice.voiceId).toBe('eve')
    expect(settings.getSettings().voice.apiKey).toBe('')
    expect(settings.getSettings().voice.openaiApiKey).toBe('')
    expect(settings.getSettings().voice.provider).toBe('xai')
    expect(settings.getSettings().voice.inputDeviceId).toBe('')
    expect(settings.getSettings().voice.outputDeviceId).toBe('')
  })

  it('round-trips a voice section without touching the other keys', () => {
    const { store: settings, backend } = store()
    settings.setSetting('yoloMaster', false)
    const next = settings.setSetting('voice', {
      enabled: true,
      wakePhrase: 'Hey Grok',
      apiKey: 'xai-test-key',
      openaiApiKey: 'sk-test',
      provider: 'openai',
      voiceId: 'alloy',
      inputDeviceId: 'mic-1',
      outputDeviceId: 'spk-1'
    })
    expect(next.voice).toEqual({
      enabled: true,
      wakePhrase: 'Hey Grok',
      apiKey: 'xai-test-key',
      openaiApiKey: 'sk-test',
      provider: 'openai',
      voiceId: 'alloy',
      inputDeviceId: 'mic-1',
      outputDeviceId: 'spk-1'
    })
    expect(next.yoloMaster).toBe(false)
    expect(backend.data.voice).toEqual(next.voice)
    expect(settings.getSettings().voice).toEqual(next.voice)
  })

  it('drops an invalid voice section without killing the rest', () => {
    const { store: settings } = store({
      yoloMaster: false,
      hideAllHotkey: 'Control+Shift+H',
      voice: { enabled: 'yes', wakePhrase: '', provider: 'anthropic' }
    })
    const result = settings.getSettings()
    expect(result.yoloMaster).toBe(false)
    expect(result.hideAllHotkey).toBe('Control+Shift+H')
    expect(result.voice).toEqual({
      enabled: false,
      wakePhrase: 'Hey Vertragus',
      apiKey: '',
      openaiApiKey: '',
      provider: 'xai',
      voiceId: 'eve',
      inputDeviceId: '',
      outputDeviceId: ''
    })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('invalid settings section'))
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
    // A `ui` write REPLACES the section, so a caller patches one field by
    // spreading the rest — the type makes forgetting that a compile error.
    settings.setSetting('ui', { ...settings.getSettings().ui, theme: 'light' })
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

  it('defaults the Pi harness wrap off and round-trips a write', () => {
    const { store: settings, backend } = store()
    expect(settings.getSettings().piHarnessEnabled).toBe(false)
    const next = settings.setSetting('piHarnessEnabled', true)
    expect(next.piHarnessEnabled).toBe(true)
    expect(backend.data.piHarnessEnabled).toBe(true)
    expect(settings.getSettings().piHarnessEnabled).toBe(true)
  })

  it('persists the panel position and the locale', () => {
    const { store: settings } = store()
    settings.setSetting('ui', {
      theme: 'dark',
      locale: 'en',
      appearance: DEFAULT_APPEARANCE,
      reflowNeighbors: true,
      onboardingDismissed: false,
      panelBounds: { edge: 'right', y: 320 }
    })
    expect(settings.getSettings().ui).toEqual({
      theme: 'dark',
      locale: 'en',
      appearance: DEFAULT_APPEARANCE,
      reflowNeighbors: true,
      onboardingDismissed: false,
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
    // An old `ui` section without an appearance reads as the design defaults —
    // the setting is new, the config file predates it, and neither is an error.
    expect(result.ui).toEqual({
      theme: 'light',
      locale: 'en',
      appearance: DEFAULT_APPEARANCE,
      reflowNeighbors: true,
      onboardingDismissed: false
    })
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

  it('derives the D4 tier from the legacy boolean when no policy is stored', () => {
    const { store: settings } = store()
    expect(effectiveAgentPolicy(settings.getSettings())).toBe('yolo')
    const { store: off } = store({ yoloMaster: false })
    expect(effectiveAgentPolicy(off.getSettings())).toBe('ask-user')
  })

  it('a stored policy wins over the boolean', () => {
    const { store: settings } = store({ yoloMaster: true, agentPolicy: 'ask-orchestrator' })
    expect(effectiveAgentPolicy(settings.getSettings())).toBe('ask-orchestrator')
  })

  it('mirrors a policy write into yoloMaster — one truth, two representations', () => {
    const { store: settings, backend } = store()
    settings.setSetting('agentPolicy', 'ask-orchestrator')
    expect(backend.data.agentPolicy).toBe('ask-orchestrator')
    expect(backend.data.yoloMaster).toBe(false)
    settings.setSetting('agentPolicy', 'yolo')
    expect(backend.data.yoloMaster).toBe(true)
  })

  it('mirrors the panel’s yolo toggle back into the policy', () => {
    const { store: settings, backend } = store({ agentPolicy: 'ask-orchestrator' })
    settings.setSetting('yoloMaster', true)
    expect(backend.data.agentPolicy).toBe('yolo')
    settings.setSetting('yoloMaster', false)
    expect(backend.data.agentPolicy).toBe('ask-user')
  })

  it('rejects an invented tier and falls back soft on read', () => {
    const { store: settings } = store()
    // @ts-expect-error — IPC input is not type-checked; the schema is the gate.
    expect(() => settings.setSetting('agentPolicy', 'full-send')).toThrow()
    const { store: corrupt } = store({ agentPolicy: 'full-send' })
    expect(effectiveAgentPolicy(corrupt.getSettings())).toBe('yolo')
  })

  it('covers every settings key with a schema field', () => {
    for (const key of SETTINGS_KEYS) {
      expect(appSettingsSchema.shape[key]).toBeDefined()
    }
    expect(Object.keys(appSettingsSchema.shape).sort()).toEqual([...SETTINGS_KEYS].sort())
    expect(SETTINGS_KEYS).toContain('mcpServers')
    expect(SETTINGS_KEYS).toContain('browserExtensionToken')
  })

  it('round-trips extra MCP servers', () => {
    const { store: settings, backend } = store()
    const servers = [
      {
        id: 'github',
        label: 'GitHub',
        transport: 'stdio' as const,
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        enabled: true
      }
    ]
    expect(settings.setSetting('mcpServers', servers).mcpServers).toEqual(servers)
    expect(backend.data.mcpServers).toEqual(servers)
  })

  it('drops an invalid MCP row on read and keeps the rest', () => {
    const { store: settings } = store({
      mcpServers: [
        { id: 'github', label: 'GitHub', transport: 'stdio', command: 'npx' },
        { id: 'broken' },
        { id: 'vertragus', label: 'Nope', transport: 'http', url: 'http://127.0.0.1/mcp' }
      ]
    })
    expect(settings.getSettings().mcpServers.map((server) => server.id)).toEqual(['github'])
  })

  it('rejects a reserved MCP id on write', () => {
    const { store: settings } = store()
    expect(() =>
      settings.setSetting('mcpServers', [
        { id: 'vertragus', label: 'Nope', transport: 'stdio', command: 'npx', enabled: true, args: [] }
      ])
    ).toThrow(/reserved/)
    expect(settings.getSettings().mcpServers).toEqual([])
  })

  /**
   * WP-1: the first-run UI language follows the OS. The rule itself is pure —
   * the Electron backend applies it exactly once, on a first run with no
   * stored `ui`, so a stored choice always wins (see createElectronBackend).
   */
  it('derives the first-run locale from the OS: de* stays German, the rest gets English', () => {
    expect(defaultLocaleForOs('de')).toBe('de')
    expect(defaultLocaleForOs('de-DE')).toBe('de')
    expect(defaultLocaleForOs('de-AT')).toBe('de')
    expect(defaultLocaleForOs('DE_CH')).toBe('de')
    expect(defaultLocaleForOs('en-US')).toBe('en')
    expect(defaultLocaleForOs('fr')).toBe('en')
    expect(defaultLocaleForOs('')).toBe('en')
    expect(defaultLocaleForOs(undefined)).toBe('en')
    // A partially German-looking tag that is not German must not match.
    expect(defaultLocaleForOs('nds')).toBe('en')
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
    expect(adopted.ui).toEqual({
      theme: 'light',
      locale: 'en',
      appearance: DEFAULT_APPEARANCE,
      reflowNeighbors: true,
      onboardingDismissed: false
    })
    expect(adopted.mcpServers).toBeUndefined()
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

describe('run retros and model learnings', () => {
  const validRetro = {
    id: 'run-1',
    workspaceId: 'ws-1',
    workspaceName: 'Limbo',
    profileId: 'p1',
    summary: 'Alles grün.',
    stats: [
      {
        roleId: 'worker',
        providerId: 'codex',
        model: 'gpt-x',
        started: 1,
        succeeded: 1,
        blocked: 0,
        failed: 0,
        unconfirmedExits: 0,
        stopped: 1
      }
    ],
    createdAt: 1_000,
    endedAt: 2_000
  }

  const validLearning = {
    id: 'learning-1',
    providerId: 'codex',
    model: 'gpt-x',
    kind: 'strength',
    insight: 'stark bei UI',
    source: 'orchestrator',
    observations: 1,
    createdAt: 1_000,
    updatedAt: 1_000
  }

  it('round-trips a retro, newest first, and upserts by id', () => {
    const { store: settings } = store()
    settings.recordRunRetro(validRetro)
    settings.recordRunRetro({ ...validRetro, id: 'run-2', endedAt: 9_000 })
    const updated = settings.recordRunRetro({ ...validRetro, summary: 'Nachgetragen.' })
    expect(updated.map((retro) => retro.id)).toEqual(['run-2', 'run-1'])
    expect(updated[1]?.summary).toBe('Nachgetragen.')
  })

  it('caps the retro history at 50, dropping the oldest', () => {
    const { store: settings } = store()
    for (let i = 0; i < 55; i += 1) {
      settings.recordRunRetro({ ...validRetro, id: `run-${i}`, endedAt: i })
    }
    const retros = settings.getRunRetros()
    expect(retros).toHaveLength(50)
    expect(retros[0]?.id).toBe('run-54')
    expect(retros.some((retro) => retro.endedAt < 5)).toBe(false)
  })

  it('rejects an invalid retro on write but drops it silently on read', () => {
    const { store: settings } = store({ runRetros: [validRetro, { id: 'broken' }] })
    expect(() => settings.recordRunRetro({ id: 'nope' })).toThrow()
    expect(settings.getRunRetros().map((retro) => retro.id)).toEqual(['run-1'])
    expect(warn).toHaveBeenCalledWith('[settings] dropped 1 invalid run retro(s)')
  })

  it('round-trips learnings and deletes by id', () => {
    const { store: settings } = store()
    settings.setModelLearnings([validLearning, { ...validLearning, id: 'learning-2' }])
    expect(settings.getModelLearnings()).toHaveLength(2)
    const remaining = settings.deleteModelLearning('learning-1')
    expect(remaining.map((learning) => learning.id)).toEqual(['learning-2'])
    expect(settings.getModelLearnings()).toHaveLength(1)
  })

  it('drops invalid learning rows on read without losing the rest', () => {
    const { store: settings } = store({ modelLearnings: [validLearning, 42] })
    expect(settings.getModelLearnings()).toHaveLength(1)
    expect(warn).toHaveBeenCalledWith('[settings] dropped 1 invalid model learning(s)')
  })
})

describe('repo notes — E2', () => {
  it('adds, filters by profile, dedupes identical notes and deletes by id', () => {
    const { store: s } = store()
    const first = s.addRepoNotes('p1', ['tests need pnpm run ci', '  ', 'panel is a drag region'])
    expect(first.filter((note) => note.profileId === 'p1')).toHaveLength(2)

    // Same note again: reinforced, not duplicated. Other profiles untouched.
    s.addRepoNotes('p1', ['tests need pnpm run ci'])
    s.addRepoNotes('p2', ['tests need pnpm run ci'])
    expect(s.getRepoNotes('p1')).toHaveLength(2)
    expect(s.getRepoNotes('p2')).toHaveLength(1)
    expect(s.getRepoNotes()).toHaveLength(3)

    const id = s.getRepoNotes('p1')[0]!.id
    s.deleteRepoNote(id)
    expect(s.getRepoNotes('p1')).toHaveLength(1)
  })

  it('caps per profile — newest win, other profiles keep theirs', () => {
    const { store: s } = store()
    s.addRepoNotes('p2', ['keep me'])
    for (let index = 0; index < 25; index += 1) {
      s.addRepoNotes('p1', [`note ${index}`])
    }
    expect(s.getRepoNotes('p1')).toHaveLength(20)
    // Newest first: the earliest notes fell off.
    expect(s.getRepoNotes('p1').some((note) => note.note === 'note 0')).toBe(false)
    expect(s.getRepoNotes('p1')[0]!.note).toBe('note 24')
    expect(s.getRepoNotes('p2')).toHaveLength(1)
  })

  it('drops corrupt rows on read instead of losing the list', () => {
    const { store: s } = store({ repoNotes: [{ junk: true }, null] })
    expect(s.getRepoNotes()).toEqual([])
    expect(warn).toHaveBeenCalled()
  })
})
