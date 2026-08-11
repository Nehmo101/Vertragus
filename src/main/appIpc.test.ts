import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The production wiring at the bottom of appIpc.ts reaches into Electron, the
 * settings store (electron-store) and three window registries. The contract
 * under test is `createAppIpc`, which takes all of that as a host — so those
 * modules are mocked away wholesale and never actually run here.
 */
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('@main/store/settings', () => ({ settings: vi.fn() }))
vi.mock('@main/providers/discovery', () => ({ discoverModels: vi.fn() }))
vi.mock('@main/providers/health', () => ({ checkAllProviders: vi.fn() }))
vi.mock('@main/windows/cliWindow', () => ({ focusCliWindow: vi.fn() }))
vi.mock('@main/windows/panel', () => ({
  getPanelWindow: vi.fn(() => null),
  isPanelWindowSender: vi.fn(() => false)
}))
vi.mock('@main/windows/profileEditor', () => ({
  isProfileEditorWindowSender: vi.fn(() => null),
  openProfileEditorWindow: vi.fn(),
  closeProfileEditorWindow: vi.fn(),
  listProfileEditorWindows: vi.fn(() => [])
}))
vi.mock('@main/windows/zoneOverlay', () => ({
  openZoneOverlayWindows: vi.fn(),
  closeZoneOverlayWindows: vi.fn(),
  isZoneOverlaySender: vi.fn(() => null),
  zoneOverlayDisplayIds: vi.fn(() => [])
}))
vi.mock('@main/windows/hideAll', () => ({
  toggleHideAll: vi.fn(),
  hideAllHotkeyStatus: vi.fn(() => undefined)
}))

import {
  APP_CHANNELS,
  createAppIpc,
  PROVIDER_HEALTH_TTL_MS,
  type AppIpc,
  type AppIpcHost,
  type AppSettingsPort,
  type PanelSettings,
  type WorkspaceDirectory,
  type WorkspaceSummary,
  type ZoneEditorPayload
} from './appIpc'
import type { MinimalIpcMain } from './ipc'
import type { WorkspaceSummary as PreloadWorkspaceSummary } from '../preload'
import { profileSchema, type Profile, type RoleTemplate } from '@shared/schema/profile'
import type { AppSettings } from './store/settings'
import type { ProviderConfig, ProviderConfigInput } from '@shared/schema/provider'
import { providerConfigSchema } from '@shared/schema/provider'
import type { ProviderHealth } from './providers/health'

type Listener = (event: { sender: { id: number } }, ...args: never[]) => unknown

class FakeIpcMain implements MinimalIpcMain {
  readonly handlers = new Map<string, Listener>()
  readonly listeners = new Map<string, Listener>()

  handle(channel: string, listener: Listener): void {
    this.handlers.set(channel, listener)
  }
  on(channel: string, listener: Listener): void {
    this.listeners.set(channel, listener)
  }
  removeHandler(channel: string): void {
    this.handlers.delete(channel)
  }
  removeAllListeners(channel: string): void {
    this.listeners.delete(channel)
  }

  invoke(channel: string, webContentsId: number, ...args: unknown[]): unknown {
    const handler = this.handlers.get(channel)
    if (!handler) throw new Error(`no handler for ${channel}`)
    return handler({ sender: { id: webContentsId } }, ...(args as never[]))
  }
  send(channel: string, webContentsId: number, ...args: unknown[]): void {
    this.listeners.get(channel)?.({ sender: { id: webContentsId } }, ...(args as never[]))
  }
}

const PANEL_ID = 1
const EDITOR_ID = 2
const CLI_ID = 3
const OVERLAY_A_ID = 4
const OVERLAY_B_ID = 5

function profile(id: string, name = id): Profile {
  return profileSchema.parse({
    id,
    name,
    repoPath: 'C:/git/demo',
    orchestrator: { providerId: 'claude' },
    slots: [{ id: `${id}-slot`, roleId: 'worker', providerId: 'claude' }]
  })
}

function provider(input: ProviderConfigInput): ProviderConfig {
  return providerConfigSchema.parse(input)
}

const SETTINGS: AppSettings = {
  ui: { theme: 'dark', locale: 'de' },
  yoloMaster: true,
  hideAllHotkey: 'Control+Alt+V',
  autostart: false,
  modelMemory: {}
}

/** An in-memory stand-in for the settings store, with the same write rules. */
function createFakeStore(initial: Profile[] = []): AppSettingsPort & { settings: AppSettings } {
  let profiles = [...initial]
  let roles: RoleTemplate[] = []
  const settings: AppSettings = structuredClone(SETTINGS)
  return {
    settings,
    getProfiles: () => profiles,
    saveProfile(raw) {
      const parsed = profileSchema.parse(raw)
      profiles = [...profiles.filter((entry) => entry.id !== parsed.id), parsed]
      return profiles
    },
    deleteProfile(id) {
      profiles = profiles.filter((entry) => entry.id !== id)
      return profiles
    },
    effectiveProviders: () => [
      provider({ id: 'claude', label: 'Claude Code', command: 'claude' }),
      provider({ id: 'codex', label: 'Codex', command: 'codex' })
    ],
    getRoleTemplates: () => roles,
    saveRoleTemplate(raw) {
      const template = raw as RoleTemplate
      roles = [...roles.filter((entry) => entry.id !== template.id), template]
      return roles
    },
    getSettings: () => settings,
    setSetting(key, value) {
      ;(settings as Record<string, unknown>)[key] = value
      return settings
    }
  }
}

function workspace(id: string, active = true): WorkspaceSummary {
  return {
    workspaceId: id,
    name: 'Paradiso',
    profileId: 'p1',
    active,
    agents: [
      {
        agentId: `${id}-orch`,
        name: 'Virgilio',
        roleId: 'orchestrator',
        roleLabel: 'Orchestrator',
        roleColor: '#cba35a',
        state: 'working',
        statusText: 'plant'
      }
    ]
  }
}

interface Harness {
  ipc: FakeIpcMain
  app: AppIpc
  store: ReturnType<typeof createFakeStore>
  broadcasts: { channel: string; payload: unknown }[]
  directory: WorkspaceDirectory & {
    started: string[]
    stopped: string[]
    focused: string[]
    change?: () => void
  }
  health: ReturnType<typeof vi.fn>
  discover: ReturnType<typeof vi.fn>
  pick: ReturnType<typeof vi.fn>
  opened: (string | undefined)[]
  closed: number[]
  hidden: number
  zoneSessions: string[]
  zonesClosed: number
  now: number
}

function harness(overrides: Partial<AppIpcHost> = {}): Harness {
  const ipc = new FakeIpcMain()
  const store = createFakeStore([profile('p1', 'Vertragus'), profile('p2', 'Terra')])
  const broadcasts: { channel: string; payload: unknown }[] = []
  const state = { workspaces: [workspace('w1')] }
  const opened: (string | undefined)[] = []
  const closed: number[] = []
  const health = vi.fn(
    async (configs: readonly ProviderConfig[]): Promise<ProviderHealth[]> =>
      configs.map((config) => ({ id: config.id, available: true, checkedAt: 1 }))
  )
  const discover = vi.fn(async (config: ProviderConfig) => ({
    models: [`${config.id}-model`],
    source: 'live' as const,
    refreshedAt: 1
  }))
  const pick = vi.fn(async () => 'C:/git/picked')
  const result = {
    ipc,
    store,
    broadcasts,
    health,
    discover,
    pick,
    opened,
    closed,
    hidden: 0,
    zoneSessions: [] as string[],
    zonesClosed: 0,
    now: 1_000
  } as Harness

  const directory = {
    started: [] as string[],
    stopped: [] as string[],
    focused: [] as string[],
    list: () => state.workspaces,
    start(profileId: string) {
      this.started.push(profileId)
    },
    stop(workspaceId: string) {
      this.stopped.push(workspaceId)
    },
    focusAgent(agentId: string) {
      this.focused.push(agentId)
    },
    onChange(listener: () => void) {
      result.directory.change = listener
      return () => {
        result.directory.change = undefined
      }
    }
  }
  result.directory = directory as Harness['directory']

  result.app = createAppIpc({
    ipcMain: ipc,
    store,
    directory: result.directory,
    isPanelSender: (id) => id === PANEL_ID,
    profileEditorSender: (id) => (id === EDITOR_ID ? 'p1' : null),
    discoverModels: discover,
    checkProviders: health,
    pickDirectory: pick,
    openProfileEditor: (profileId) => opened.push(profileId),
    closeProfileEditor: (id) => closed.push(id),
    broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
    hideAll: () => {
      result.hidden += 1
    },
    openZoneOverlays: (profileId) => result.zoneSessions.push(profileId),
    closeZoneOverlays: () => {
      result.zonesClosed += 1
    },
    zoneOverlaySender: (id) =>
      id === OVERLAY_A_ID
        ? { profileId: 'p1', displayId: 11 }
        : id === OVERLAY_B_ID
          ? { profileId: 'p1', displayId: 22 }
          : null,
    zoneOverlayDisplayIds: () => [11, 22],
    now: () => result.now,
    ...overrides
  })
  return result
}

/** A zone rect payload as an overlay sends it (relative to its work area). */
function rel(x: number, y: number, w: number, h: number): {
  x: number
  y: number
  w: number
  h: number
} {
  return { x, y, w, h }
}

let h: Harness

beforeEach(() => {
  h = harness()
})

describe('profiles', () => {
  it('lists profiles for the panel and for an editor window', () => {
    expect((h.ipc.invoke(APP_CHANNELS.profilesList, PANEL_ID) as Profile[]).map((p) => p.id)).toEqual(
      ['p1', 'p2']
    )
    expect(h.ipc.invoke(APP_CHANNELS.profilesList, EDITOR_ID)).toHaveLength(2)
  })

  it('saves a valid profile and announces the new list', () => {
    const next = { ...profile('p3', 'Neu') }
    const profiles = h.ipc.invoke(APP_CHANNELS.profilesSave, EDITOR_ID, next) as Profile[]

    expect(profiles.map((entry) => entry.id)).toEqual(['p1', 'p2', 'p3'])
    expect(h.broadcasts).toEqual([{ channel: APP_CHANNELS.eventProfiles, payload: profiles }])
  })

  it('rejects an invalid profile instead of writing half of it', () => {
    expect(() =>
      h.ipc.invoke(APP_CHANNELS.profilesSave, PANEL_ID, { id: 'x', name: '' })
    ).toThrow()
    expect(h.store.getProfiles()).toHaveLength(2)
    expect(h.broadcasts).toEqual([])
  })

  it('deletes by id and announces the result', () => {
    const profiles = h.ipc.invoke(APP_CHANNELS.profilesDelete, PANEL_ID, { id: 'p1' }) as Profile[]
    expect(profiles.map((entry) => entry.id)).toEqual(['p2'])
    expect(h.broadcasts.at(-1)?.channel).toBe(APP_CHANNELS.eventProfiles)
  })

  it('refuses a delete without an id', () => {
    expect(() => h.ipc.invoke(APP_CHANNELS.profilesDelete, PANEL_ID, {})).toThrow(/missing profile id/)
  })
})

describe('roles', () => {
  it('stores a custom role template and hands the list back', () => {
    const template: RoleTemplate = { id: 'r1', name: 'Bugjäger', prompt: 'Find bugs.', builtin: false }
    expect(h.ipc.invoke(APP_CHANNELS.rolesSave, EDITOR_ID, template)).toEqual([template])
    expect(h.ipc.invoke(APP_CHANNELS.rolesList, EDITOR_ID)).toEqual([template])
  })
})

describe('providers and models', () => {
  it('returns every provider with its health probe', async () => {
    const entries = (await h.ipc.invoke(APP_CHANNELS.providersList, EDITOR_ID)) as {
      config: ProviderConfig
      health?: ProviderHealth
    }[]

    expect(entries.map((entry) => entry.config.id)).toEqual(['claude', 'codex'])
    expect(entries[0]!.health?.available).toBe(true)
    expect(h.health).toHaveBeenCalledTimes(1)
  })

  it('reuses the probe result inside the cache window and re-probes after it', async () => {
    await h.ipc.invoke(APP_CHANNELS.providersList, PANEL_ID)
    await h.ipc.invoke(APP_CHANNELS.providersList, PANEL_ID)
    expect(h.health).toHaveBeenCalledTimes(1)

    h.now += PROVIDER_HEALTH_TTL_MS + 1
    await h.ipc.invoke(APP_CHANNELS.providersList, PANEL_ID)
    expect(h.health).toHaveBeenCalledTimes(2)
  })

  it('discovers models for a known provider', async () => {
    const result = await h.ipc.invoke(APP_CHANNELS.modelsDiscover, EDITOR_ID, {
      providerId: 'codex'
    })
    expect(result).toMatchObject({ models: ['codex-model'], source: 'live' })
    expect(h.discover.mock.calls[0]![0]).toMatchObject({ id: 'codex' })
  })

  it('refuses discovery for a provider that does not exist', async () => {
    await expect(
      Promise.resolve(h.ipc.invoke(APP_CHANNELS.modelsDiscover, EDITOR_ID, { providerId: 'ghost' }))
    ).rejects.toThrow(/unknown provider/)
  })
})

describe('workspaces', () => {
  it('lists the directory', () => {
    expect(h.ipc.invoke(APP_CHANNELS.workspacesList, PANEL_ID)).toHaveLength(1)
  })

  it('starts, stops and focuses, announcing the list after each change', async () => {
    await h.ipc.invoke(APP_CHANNELS.workspacesStart, PANEL_ID, { profileId: 'p1' })
    await h.ipc.invoke(APP_CHANNELS.workspacesStop, PANEL_ID, { workspaceId: 'w1' })
    h.ipc.invoke(APP_CHANNELS.workspacesFocusAgent, PANEL_ID, { agentId: 'w1-orch' })

    expect(h.directory.started).toEqual(['p1'])
    expect(h.directory.stopped).toEqual(['w1'])
    expect(h.directory.focused).toEqual(['w1-orch'])
    expect(h.broadcasts.map((entry) => entry.channel)).toEqual([
      APP_CHANNELS.eventWorkspaces,
      APP_CHANNELS.eventWorkspaces
    ])
  })

  it('surfaces a refusing directory instead of swallowing it', async () => {
    const failing = harness({
      directory: {
        list: () => [],
        start() {
          throw new Error('Workspace-Manager ist noch nicht verdrahtet.')
        },
        stop() {},
        focusAgent() {}
      }
    })
    await expect(
      Promise.resolve(
        failing.ipc.invoke(APP_CHANNELS.workspacesStart, PANEL_ID, { profileId: 'p1' })
      )
    ).rejects.toThrow(/nicht verdrahtet/)
  })

  it('pushes the list when the directory reports a change', () => {
    h.directory.change?.()
    expect(h.broadcasts).toEqual([
      { channel: APP_CHANNELS.eventWorkspaces, payload: h.directory.list() }
    ])
  })
})

describe('settings and windows', () => {
  it('returns only the settings the panel shows', () => {
    expect(h.ipc.invoke(APP_CHANNELS.settingsGet, PANEL_ID)).toEqual({
      yoloMaster: true,
      hideAllHotkey: 'Control+Alt+V',
      locale: 'de'
    })
  })

  it('toggles the yolo master', () => {
    expect(h.ipc.invoke(APP_CHANNELS.settingsYolo, PANEL_ID, { enabled: false })).toMatchObject({
      yoloMaster: false
    })
    expect(h.store.settings.yoloMaster).toBe(false)
  })

  it('rejects a yolo payload that is not a boolean', () => {
    expect(() => h.ipc.invoke(APP_CHANNELS.settingsYolo, PANEL_ID, { enabled: 'yes' })).toThrow(
      /expected a boolean/
    )
  })

  it('runs hide-all and the folder picker', async () => {
    h.ipc.invoke(APP_CHANNELS.windowsHideAll, PANEL_ID)
    expect(h.hidden).toBe(1)

    await expect(
      h.ipc.invoke(APP_CHANNELS.dialogPickDirectory, EDITOR_ID, { defaultPath: 'C:/git' })
    ).resolves.toBe('C:/git/picked')
    expect(h.pick).toHaveBeenCalledWith(EDITOR_ID, 'C:/git')
  })

  it('opens the editor from the panel and from another editor', () => {
    h.ipc.invoke(APP_CHANNELS.profileEditorOpen, PANEL_ID, { profileId: 'p1' })
    h.ipc.invoke(APP_CHANNELS.profileEditorOpen, EDITOR_ID, {})
    expect(h.opened).toEqual(['p1', undefined])
  })

  it('lets only an editor close an editor', () => {
    h.ipc.send(APP_CHANNELS.profileEditorClose, CLI_ID)
    h.ipc.send(APP_CHANNELS.profileEditorClose, PANEL_ID)
    expect(h.closed).toEqual([])

    h.ipc.send(APP_CHANNELS.profileEditorClose, EDITOR_ID)
    expect(h.closed).toEqual([EDITOR_ID])
  })
})

describe('sender authorization', () => {
  const panelOnly = [
    APP_CHANNELS.workspacesList,
    APP_CHANNELS.workspacesStart,
    APP_CHANNELS.workspacesStop,
    APP_CHANNELS.workspacesFocusAgent,
    APP_CHANNELS.settingsYolo,
    APP_CHANNELS.windowsHideAll
  ]
  const appWindows = [
    APP_CHANNELS.profilesList,
    APP_CHANNELS.profilesSave,
    APP_CHANNELS.profilesDelete,
    APP_CHANNELS.rolesList,
    APP_CHANNELS.rolesSave,
    APP_CHANNELS.providersList,
    APP_CHANNELS.modelsDiscover,
    APP_CHANNELS.settingsGet,
    APP_CHANNELS.dialogPickDirectory,
    APP_CHANNELS.profileEditorOpen,
    APP_CHANNELS.zonesEdit
  ]

  it('rejects a CLI window on every channel', () => {
    for (const channel of [...panelOnly, ...appWindows]) {
      expect(() => h.ipc.invoke(channel, CLI_ID, {})).toThrow(/rejected — sender is not/)
    }
  })

  it('rejects the profile editor on the panel-only channels', () => {
    for (const channel of panelOnly) {
      expect(() => h.ipc.invoke(channel, EDITOR_ID, {})).toThrow(/not the panel window/)
    }
  })

  it('never lets an unauthorized sender reach the store or the directory', () => {
    expect(() => h.ipc.invoke(APP_CHANNELS.profilesSave, CLI_ID, profile('evil'))).toThrow()
    expect(() => h.ipc.invoke(APP_CHANNELS.workspacesStart, CLI_ID, { profileId: 'p1' })).toThrow()
    expect(h.store.getProfiles().map((entry) => entry.id)).toEqual(['p1', 'p2'])
    expect(h.directory.started).toEqual([])
  })
})

describe('zones', () => {
  it('opens the overlay session for a saved profile', () => {
    h.ipc.invoke(APP_CHANNELS.zonesEdit, EDITOR_ID, { profileId: 'p1' })
    expect(h.zoneSessions).toEqual(['p1'])
  })

  it('refuses to open zones for a profile that does not exist yet', () => {
    expect(() => h.ipc.invoke(APP_CHANNELS.zonesEdit, EDITOR_ID, { profileId: 'ghost' })).toThrow(
      /unknown profile/
    )
    expect(h.zoneSessions).toEqual([])
  })

  it('hands an overlay its display’s zones and the role palette', () => {
    h.store.saveProfile({
      ...profile('p1', 'Vertragus'),
      zones: {
        zones: [
          { roleId: 'worker', displayId: 11, rect: rel(0.5, 0, 0.5, 1) },
          { roleId: 'worker', displayId: 22, rect: rel(0, 0, 0.4, 1) }
        ]
      }
    })
    const payload = h.ipc.invoke(APP_CHANNELS.zonesLoad, OVERLAY_A_ID) as ZoneEditorPayload

    expect(payload.profileId).toBe('p1')
    expect(payload.profileName).toBe('Vertragus')
    expect(payload.displayId).toBe(11)
    // Orchestrator first, then the profile's slot roles.
    expect(payload.roles.map((role) => role.roleId)).toEqual(['orchestrator', 'worker'])
    // Only this display's zones — the other overlay owns display 22.
    expect(payload.zones).toEqual([
      { roleId: 'worker', displayId: 11, rect: rel(0.5, 0, 0.5, 1) }
    ])
  })

  it('saves the layout of every overlay, not just the one that clicked save', () => {
    h.ipc.send(APP_CHANNELS.zonesDraft, OVERLAY_B_ID, {
      zones: [{ roleId: 'reviewer', rect: rel(0, 0, 0.5, 1) }]
    })
    h.ipc.invoke(APP_CHANNELS.zonesSave, OVERLAY_A_ID, {
      profileId: 'p1',
      zones: [{ roleId: 'worker', rect: rel(0.5, 0, 0.5, 1) }]
    })

    const saved = h.store.getProfiles().find((entry) => entry.id === 'p1')!
    expect(saved.zones?.zones).toEqual([
      { roleId: 'worker', displayId: 11, rect: rel(0.5, 0, 0.5, 1) },
      { roleId: 'reviewer', displayId: 22, rect: rel(0, 0, 0.5, 1) }
    ])
    expect(h.zonesClosed).toBe(1)
    expect(h.broadcasts.at(-1)?.channel).toBe(APP_CHANNELS.eventProfiles)
  })

  it('stamps the sender’s display id, whatever the payload claims', () => {
    h.ipc.invoke(APP_CHANNELS.zonesSave, OVERLAY_A_ID, {
      profileId: 'p1',
      zones: [{ roleId: 'worker', displayId: 999, rect: rel(0, 0, 0.5, 1) }]
    })

    const saved = h.store.getProfiles().find((entry) => entry.id === 'p1')!
    expect(saved.zones?.zones.map((zone) => zone.displayId)).toEqual([11])
  })

  it('keeps zones of displays that were not part of the session', () => {
    h.store.saveProfile({
      ...profile('p1', 'Vertragus'),
      zones: { zones: [{ roleId: 'worker', displayId: 77, rect: rel(0, 0, 1, 1) }] }
    })
    h.ipc.invoke(APP_CHANNELS.zonesSave, OVERLAY_A_ID, {
      profileId: 'p1',
      zones: [{ roleId: 'worker', rect: rel(0.5, 0, 0.5, 1) }]
    })

    const saved = h.store.getProfiles().find((entry) => entry.id === 'p1')!
    expect(saved.zones?.zones).toEqual([
      { roleId: 'worker', displayId: 77, rect: rel(0, 0, 1, 1) },
      { roleId: 'worker', displayId: 11, rect: rel(0.5, 0, 0.5, 1) }
    ])
  })

  it('an empty save deletes this display’s zones', () => {
    h.store.saveProfile({
      ...profile('p1', 'Vertragus'),
      zones: { zones: [{ roleId: 'worker', displayId: 11, rect: rel(0, 0, 1, 1) }] }
    })
    h.ipc.invoke(APP_CHANNELS.zonesSave, OVERLAY_A_ID, { profileId: 'p1', zones: [] })

    expect(h.store.getProfiles().find((entry) => entry.id === 'p1')!.zones?.zones).toEqual([])
  })

  it('rejects a save for a profile the overlay does not belong to', () => {
    expect(() =>
      h.ipc.invoke(APP_CHANNELS.zonesSave, OVERLAY_A_ID, { profileId: 'p2', zones: [] })
    ).toThrow(/does not belong to this overlay/)
  })

  it('rejects every zone channel from a panel, an editor or a CLI window', () => {
    for (const sender of [PANEL_ID, EDITOR_ID, CLI_ID]) {
      expect(() => h.ipc.invoke(APP_CHANNELS.zonesLoad, sender)).toThrow(
        /not a zone overlay window/
      )
      expect(() =>
        h.ipc.invoke(APP_CHANNELS.zonesSave, sender, { profileId: 'p1', zones: [] })
      ).toThrow(/not a zone overlay window/)
    }
    // The fire-and-forget channels ignore strangers instead of throwing.
    h.ipc.send(APP_CHANNELS.zonesDraft, CLI_ID, { zones: [] })
    h.ipc.send(APP_CHANNELS.zonesCancel, CLI_ID)
    expect(h.zonesClosed).toBe(0)
    expect(h.store.getProfiles().find((entry) => entry.id === 'p1')!.zones).toBeUndefined()
  })

  it('cancel closes the session and saves nothing', () => {
    h.ipc.send(APP_CHANNELS.zonesDraft, OVERLAY_A_ID, {
      zones: [{ roleId: 'worker', rect: rel(0, 0, 0.5, 1) }]
    })
    h.ipc.send(APP_CHANNELS.zonesCancel, OVERLAY_A_ID)

    expect(h.zonesClosed).toBe(1)
    expect(h.store.getProfiles().find((entry) => entry.id === 'p1')!.zones).toBeUndefined()

    // The dropped draft must not resurface in the next session's save.
    h.ipc.invoke(APP_CHANNELS.zonesSave, OVERLAY_B_ID, { profileId: 'p1', zones: [] })
    expect(h.store.getProfiles().find((entry) => entry.id === 'p1')!.zones?.zones).toEqual([])
  })

  it('drops a malformed draft instead of throwing at a dragging renderer', () => {
    expect(() => h.ipc.send(APP_CHANNELS.zonesDraft, OVERLAY_A_ID, { zones: 'nope' })).not.toThrow()
    h.ipc.invoke(APP_CHANNELS.zonesSave, OVERLAY_A_ID, { profileId: 'p1', zones: [] })
    expect(h.store.getProfiles().find((entry) => entry.id === 'p1')!.zones?.zones).toEqual([])
  })

  it('refuses a save whose zones are not a list', () => {
    expect(() =>
      h.ipc.invoke(APP_CHANNELS.zonesSave, OVERLAY_A_ID, { profileId: 'p1', zones: 42 })
    ).toThrow(/expected an array of zones/)
  })
})

describe('the hide-all hotkey status', () => {
  it('stays out of the settings payload while the hotkey works', () => {
    const settings = h.ipc.invoke(APP_CHANNELS.settingsGet, PANEL_ID) as PanelSettings
    expect(settings.hideAllHotkeyError).toBeUndefined()
    expect(settings.hideAllHotkey).toBe('Control+Alt+V')
  })

  it('reaches the panel when registration failed', () => {
    const failing = harness({
      hotkeyStatus: () => ({
        hotkey: 'Control+Alt+V',
        registered: false,
        error: 'Hotkey Control+Alt+V ist belegt'
      })
    })
    const settings = failing.ipc.invoke(APP_CHANNELS.settingsGet, PANEL_ID) as PanelSettings

    expect(settings.hideAllHotkeyError).toBe('Hotkey Control+Alt+V ist belegt')
    // …and it survives a yolo toggle, which returns the same shape.
    const afterToggle = failing.ipc.invoke(APP_CHANNELS.settingsYolo, PANEL_ID, {
      enabled: false
    }) as PanelSettings
    expect(afterToggle.hideAllHotkeyError).toBe('Hotkey Control+Alt+V ist belegt')
  })
})

describe('lifecycle', () => {
  it('dispose unhooks every channel and the directory subscription', () => {
    h.app.dispose()
    expect(h.ipc.handlers.size).toBe(0)
    expect(h.ipc.listeners.size).toBe(0)
    expect(h.directory.change).toBeUndefined()
  })

  it('emitWorkspaces and emitProfiles push the current state on demand', () => {
    h.app.emitWorkspaces()
    h.app.emitProfiles()
    expect(h.broadcasts.map((entry) => entry.channel)).toEqual([
      APP_CHANNELS.eventWorkspaces,
      APP_CHANNELS.eventProfiles
    ])
  })
})

describe('preload parity', () => {
  it('uses exactly the channel names main registers', () => {
    const source = readFileSync(join(__dirname, '../preload/index.ts'), 'utf8')
    for (const channel of Object.values(APP_CHANNELS)) {
      expect(source).toContain(`'${channel}'`)
    }
    const found = [
      ...source.matchAll(
        /'((?:profiles|roles|providers|models|workspaces|settings|windows|dialog|profileEditor|zones|ev):[a-zA-Z]+)'/g
      )
    ].map((match) => match[1])
    expect(new Set(found)).toEqual(new Set(Object.values(APP_CHANNELS)))
  })

  it('keeps the workspace payload type identical on both sides of the bridge', () => {
    // Compile-time only: preload cannot import main, so the two declarations
    // are checked against each other here instead of drifting silently.
    const fromMain: WorkspaceSummary = workspace('w1')
    const toPreload: PreloadWorkspaceSummary = fromMain
    const backAgain: WorkspaceSummary = toPreload
    expect(backAgain).toBe(fromMain)
  })
})
