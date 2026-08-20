import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The production wiring at the bottom of appIpc.ts reaches into Electron, the
 * settings store (electron-store) and three window registries. The contract
 * under test is `createAppIpc`, which takes all of that as a host — so those
 * modules are mocked away wholesale and never actually run here.
 */
vi.mock('electron', () => ({
  app: { quit: vi.fn() },
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn(), removeAllListeners: vi.fn() },
  dialog: { showOpenDialog: vi.fn(), showMessageBox: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('@main/store/settings', async (importOriginal) => ({
  // The real helpers (effectiveAgentPolicy) stay; only the Electron-backed
  // store singleton is stubbed out.
  ...(await importOriginal<typeof import('@main/store/settings')>()),
  settings: vi.fn()
}))
vi.mock('@main/providers/discovery', () => ({ discoverModels: vi.fn() }))
vi.mock('@main/providers/health', () => ({ checkAllProviders: vi.fn() }))
vi.mock('@main/windows/cliWindow', () => ({
  focusCliWindow: vi.fn(),
  listCliWindows: vi.fn(() => [])
}))
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
vi.mock('@main/windows/providerEditor', () => ({
  isProviderEditorWindowSender: vi.fn(() => null),
  openProviderEditorWindow: vi.fn(),
  closeProviderEditorWindow: vi.fn(),
  listProviderEditorWindows: vi.fn(() => [])
}))
vi.mock('@main/windows/settingsWindow', () => ({
  isSettingsWindowSender: vi.fn(() => false),
  openSettingsWindow: vi.fn(),
  closeSettingsWindow: vi.fn(),
  getSettingsWindow: vi.fn(() => null)
}))
vi.mock('@main/updater', () => ({
  appUpdater: vi.fn(() => ({
    state: vi.fn(),
    check: vi.fn(),
    setChannel: vi.fn(),
    install: vi.fn()
  })),
  onUpdateState: vi.fn(() => () => undefined)
}))
vi.mock('@main/windows/zoneOverlay', () => ({
  openZoneOverlayWindows: vi.fn(),
  closeZoneOverlayWindows: vi.fn(),
  isZoneOverlaySender: vi.fn(() => null),
  listZoneOverlayWindows: vi.fn(() => []),
  zoneOverlayDisplayIds: vi.fn(() => []),
  selectZoneOverlayDisplay: vi.fn(() => false),
  listZoneDisplays: vi.fn(() => [])
}))
vi.mock('@main/windows/hideAll', () => ({
  toggleHideAll: vi.fn(),
  hideAllHotkeyStatus: vi.fn(() => undefined),
  reRegisterHideAllShortcut: vi.fn(() => ({ hotkey: 'Control+Alt+V', registered: true }))
}))

import { ipcMain } from 'electron'
import { isPanelWindowSender } from '@main/windows/panel'
import { openProfileEditorWindow } from '@main/windows/profileEditor'
import { settings } from '@main/store/settings'
import {
  APP_CHANNELS,
  createAppIpc,
  disposeAppIpc,
  PROVIDER_HEALTH_TTL_MS,
  quitConfirmationText,
  registerAppIpc,
  runningAgentCount,
  WRITABLE_SETTINGS,
  type AppIpc,
  type AppIpcHost,
  type AppSettingsPort,
  type PanelSettings,
  type UpdateStatePayload,
  type WorkspaceDirectory,
  type WorkspaceSummary,
  type ZoneEditorPayload
} from './appIpc'
import type { HideAllHotkeyStatus } from './windows/hideAll'
import { REMOTE_CHANNELS } from './remote/ipc'
import type { MinimalIpcMain } from './ipc'
import type { WorkspaceSummary as PreloadWorkspaceSummary } from '../preload'
import { profileSchema, type Profile, type RoleTemplate } from '@shared/schema/profile'
import type { ModelLearning, RepoNote, RunRetro } from '@shared/schema/retro'
import { DEFAULT_APPEARANCE } from '@shared/appearance'
import type { AppSettings } from './store/settings'
import type { ProviderConfig, ProviderConfigInput } from '@shared/schema/provider'
import { mergeProviderConfigs, providerConfigSchema } from '@shared/schema/provider'
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
const SETTINGS_ID = 6
const PROVIDER_EDITOR_ID = 7

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
  ui: { theme: 'dark', locale: 'de', appearance: DEFAULT_APPEARANCE },
  remote: { enabled: false, bindAddress: '', port: 9482 },
  yoloMaster: true,
  hideAllHotkey: 'Control+Alt+V',
  autostart: false,
  updateChannel: 'main',
  modelMemory: {}
}

/** An in-memory stand-in for the settings store, with the same write rules. */
function createFakeStore(
  initial: Profile[] = []
): AppSettingsPort & {
  settings: AppSettings
  retros: RunRetro[]
  learnings: ModelLearning[]
} {
  let profiles = [...initial]
  let roles: RoleTemplate[] = []
  let storedProviders: ProviderConfig[] = []
  const settings: AppSettings = structuredClone(SETTINGS)
  const retroState = {
    retros: [] as RunRetro[],
    learnings: [] as ModelLearning[],
    repoNotes: [] as RepoNote[]
  }
  return {
    settings,
    get retros() {
      return retroState.retros
    },
    set retros(next: RunRetro[]) {
      retroState.retros = next
    },
    get learnings() {
      return retroState.learnings
    },
    set learnings(next: ModelLearning[]) {
      retroState.learnings = next
    },
    getRunRetros: () => [...retroState.retros],
    getModelLearnings: () => [...retroState.learnings],
    deleteModelLearning(id) {
      retroState.learnings = retroState.learnings.filter((entry) => entry.id !== id)
      return [...retroState.learnings]
    },
    getRepoNotes: (profileId) =>
      profileId
        ? retroState.repoNotes.filter((entry) => entry.profileId === profileId)
        : [...retroState.repoNotes],
    deleteRepoNote(id) {
      retroState.repoNotes = retroState.repoNotes.filter((entry) => entry.id !== id)
      return [...retroState.repoNotes]
    },
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
    // Presets merged with stored overrides, exactly like the real store: a
    // stored entry with a preset id REPLACES it, unknown ids are appended.
    effectiveProviders: () =>
      mergeProviderConfigs(
        [
          provider({ id: 'claude', label: 'Claude Code', command: 'claude', presetId: 'claude' }),
          provider({ id: 'codex', label: 'Codex', command: 'codex', presetId: 'codex' })
        ],
        storedProviders
      ),
    saveProvider(raw) {
      const parsed = providerConfigSchema.parse(raw)
      storedProviders = [...storedProviders.filter((entry) => entry.id !== parsed.id), parsed]
      return storedProviders
    },
    deleteProvider(id) {
      storedProviders = storedProviders.filter((entry) => entry.id !== id)
      return storedProviders
    },
    getRoleTemplates: () => roles,
    saveRoleTemplate(raw) {
      const template = raw as RoleTemplate
      roles = [...roles.filter((entry) => entry.id !== template.id), template]
      return roles
    },
    getSettings: () => settings,
    setSetting(key, value) {
      ;(settings as Record<string, unknown>)[key] = value
      // D4 mirror — same write rule as the real store, so panelSettings sees
      // one truth here too.
      if (key === 'agentPolicy' && value !== undefined) {
        settings.yoloMaster = value === 'yolo'
      } else if (key === 'yoloMaster') {
        settings.agentPolicy = value ? 'yolo' : 'ask-user'
      }
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
    started: Array<{ profileId: string; goal?: string }>
    stopped: string[]
    focused: string[]
    focusedWorkspaces: string[]
    closedAgents: string[]
    answered: Array<{ workspaceId: string; agentId: string; questionId: string; text: string }>
    userMessages: Array<{ workspaceId: string; text: string }>
    promoted: Array<{ workspaceId: string; agentId: string }>
    removedWorktrees: Array<{ profileId: string; path: string }>
    staleWorktrees: { path: string; branch?: string }[]
    change?: () => void
  }
  health: ReturnType<typeof vi.fn>
  discover: ReturnType<typeof vi.fn>
  pick: ReturnType<typeof vi.fn>
  opened: (string | undefined)[]
  closed: number[]
  providerEditorsOpened: (string | undefined)[]
  providerEditorsClosed: number[]
  hidden: number
  /** How often the panel put ITSELF down — windows:minimizePanel, not hide-all. */
  panelMinimizes: number
  /** Agent counts the quit dialog was asked about, in order. */
  quitPrompts: number[]
  /** What the fake user answers in that dialog. */
  confirmQuit: boolean
  quits: number
  zoneSessions: string[]
  zonesClosed: number
  pickedDisplays: number[]
  now: number
  /** Settings window: how often it was opened / closed, and the live hotkey. */
  settingsOpened: number
  settingsClosed: number
  registeredHotkeys: string[]
  /** What the fake OS answers when a hotkey is (re-)registered. */
  hotkeyRegisters: boolean
  hotkeyStatus?: HideAllHotkeyStatus
  autostartWrites: boolean[]
  autostartSupported: boolean
  update: UpdateStatePayload
  channelWrites: string[]
  updateChecks: number
  installs: number
  /** Push a new update state to whoever subscribed (the IPC layer). */
  pushUpdate(next: Partial<UpdateStatePayload>): void
}

function harness(overrides: Partial<AppIpcHost> = {}): Harness {
  const ipc = new FakeIpcMain()
  const store = createFakeStore([profile('p1', 'Vertragus'), profile('p2', 'Terra')])
  const broadcasts: { channel: string; payload: unknown }[] = []
  const state = { workspaces: [workspace('w1')] }
  const opened: (string | undefined)[] = []
  const closed: number[] = []
  const providerEditorsOpened: (string | undefined)[] = []
  const providerEditorsClosed: number[] = []
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
    providerEditorsOpened,
    providerEditorsClosed,
    hidden: 0,
    panelMinimizes: 0,
    quitPrompts: [] as number[],
    confirmQuit: true,
    quits: 0,
    zoneSessions: [] as string[],
    zonesClosed: 0,
    pickedDisplays: [] as number[],
    now: 1_000,
    settingsOpened: 0,
    settingsClosed: 0,
    registeredHotkeys: [] as string[],
    hotkeyRegisters: true,
    autostartWrites: [] as boolean[],
    autostartSupported: true,
    update: {
      status: 'idle',
      currentVersion: '1.2.3',
      channel: 'main' as const
    },
    channelWrites: [] as string[],
    updateChecks: 0,
    installs: 0
  } as Harness

  let pushUpdateState: ((state: UpdateStatePayload) => void) | undefined
  result.pushUpdate = (next) => {
    result.update = { ...result.update, ...next }
    pushUpdateState?.(result.update)
  }

  const directory = {
    started: [] as Array<{ profileId: string; goal?: string }>,
    stopped: [] as string[],
    focused: [] as string[],
    focusedWorkspaces: [] as string[],
    closedAgents: [] as string[],
    answered: [] as Array<{ workspaceId: string; agentId: string; questionId: string; text: string }>,
    userMessages: [] as Array<{ workspaceId: string; text: string }>,
    promoted: [] as Array<{ workspaceId: string; agentId: string }>,
    removedWorktrees: [] as Array<{ profileId: string; path: string }>,
    staleWorktrees: [
      { path: '/repo/.vertragus/worktrees/old-1', branch: 'vertragus/paradiso/caronte' }
    ] as { path: string; branch?: string }[],
    list: () => state.workspaces,
    start(profileId: string, goal?: string) {
      this.started.push({ profileId, ...(goal !== undefined ? { goal } : {}) })
    },
    stop(workspaceId: string) {
      this.stopped.push(workspaceId)
    },
    async answerQuestion(workspaceId: string, agentId: string, questionId: string, text: string) {
      this.answered.push({ workspaceId, agentId, questionId, text })
    },
    postUserMessage(workspaceId: string, text: string) {
      this.userMessages.push({ workspaceId, text })
    },
    async promoteAgentBranch(workspaceId: string, agentId: string) {
      this.promoted.push({ workspaceId, agentId })
    },
    focusAgent(agentId: string) {
      this.focused.push(agentId)
    },
    closeAgentWindow(agentId: string) {
      this.closedAgents.push(agentId)
    },
    focusWorkspace(workspaceId: string) {
      this.focusedWorkspaces.push(workspaceId)
    },
    async listStaleWorktrees(profileId: string) {
      if (profileId === 'unknown') throw new Error(`Unbekanntes Profil ${profileId}`)
      return this.staleWorktrees
    },
    async removeWorktree(profileId: string, path: string) {
      this.removedWorktrees.push({ profileId, path })
      this.staleWorktrees = this.staleWorktrees.filter((entry) => entry.path !== path)
      return this.staleWorktrees
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
    providerEditorSender: (id) => (id === PROVIDER_EDITOR_ID ? 'claude' : null),
    discoverModels: discover,
    checkProviders: health,
    pickDirectory: pick,
    openProfileEditor: (profileId) => opened.push(profileId),
    closeProfileEditor: (id) => closed.push(id),
    openProviderEditor: (providerId) => providerEditorsOpened.push(providerId),
    closeProviderEditor: (id) => providerEditorsClosed.push(id),
    broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
    hideAll: () => {
      result.hidden += 1
    },
    minimizePanel: () => {
      result.panelMinimizes += 1
    },
    confirmQuit: async (runningAgents) => {
      result.quitPrompts.push(runningAgents)
      return result.confirmQuit
    },
    quit: () => {
      result.quits += 1
    },
    openZoneOverlays: (profileId) => result.zoneSessions.push(profileId),
    closeZoneOverlays: () => {
      result.zonesClosed += 1
    },
    selectZoneOverlayDisplay: (displayId) => {
      result.pickedDisplays.push(displayId)
      return displayId === 11 || displayId === 22
    },
    listZoneDisplays: () => [
      { id: 11, label: 'Main', width: 1920, height: 1040, primary: true },
      { id: 22, label: 'Side', width: 1600, height: 860, primary: false }
    ],
    zoneOverlaySender: (id) =>
      id === OVERLAY_A_ID
        ? { profileId: 'p1', displayId: 11, pick: false }
        : id === OVERLAY_B_ID
          ? { profileId: 'p1', displayId: 22, pick: false }
          : null,
    zoneOverlayDisplayIds: () => [11, 22],
    now: () => result.now,

    isSettingsSender: (id) => id === SETTINGS_ID,
    openSettings: () => {
      result.settingsOpened += 1
    },
    closeSettings: () => {
      result.settingsClosed += 1
    },
    reRegisterHotkey: (hotkey) => {
      result.registeredHotkeys.push(hotkey)
      // Mirrors production: the module-level status IS the last attempt, which
      // is what `settings:get` reports back as `hideAllHotkeyError`.
      result.hotkeyStatus = result.hotkeyRegisters
        ? { hotkey, registered: true }
        : { hotkey, registered: false, error: `Hotkey ${hotkey} ist belegt.` }
      return result.hotkeyStatus
    },
    hotkeyStatus: () => result.hotkeyStatus,
    setAutostart: (enabled) => {
      result.autostartWrites.push(enabled)
    },
    autostartSupported: () => result.autostartSupported,
    updateState: () => result.update,
    setUpdateChannel: async (channel) => {
      result.channelWrites.push(channel)
      result.update = { ...result.update, channel }
      store.setSetting('updateChannel', channel)
      return result.update
    },
    checkForUpdates: async () => {
      result.updateChecks += 1
      return result.update
    },
    installUpdate: () => {
      result.installs += 1
    },
    onUpdateState: (listener) => {
      pushUpdateState = listener
      return () => {
        pushUpdateState = undefined
      }
    },
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

describe('provider descriptors', () => {
  const custom = {
    id: 'my-cli',
    label: 'Mein CLI',
    command: 'mycli',
    mcp: { kind: 'claude-json', configArg: '--mcp-config' }
  }

  it('appends a custom provider and announces the merged list', () => {
    const configs = h.ipc.invoke(
      APP_CHANNELS.providersSave,
      PROVIDER_EDITOR_ID,
      custom
    ) as ProviderConfig[]

    expect(configs.map((entry) => entry.id)).toEqual(['claude', 'codex', 'my-cli'])
    expect(h.broadcasts).toEqual([
      { channel: APP_CHANNELS.eventProviders, payload: configs }
    ])
  })

  it('lets a save under a preset id REPLACE the built-in', () => {
    h.ipc.invoke(APP_CHANNELS.providersSave, PANEL_ID, {
      id: 'codex',
      presetId: 'codex',
      label: 'Codex (mein Fork)',
      command: 'codex-fork'
    })
    const configs = h.store.effectiveProviders()
    // Replaced in place — the picker order must not jump around on an edit.
    expect(configs.map((entry) => entry.id)).toEqual(['claude', 'codex'])
    expect(configs[1]!.command).toBe('codex-fork')
  })

  it('resets a preset by deleting the override', () => {
    h.ipc.invoke(APP_CHANNELS.providersSave, PANEL_ID, {
      id: 'codex',
      presetId: 'codex',
      label: 'Codex (mein Fork)',
      command: 'codex-fork'
    })
    const configs = h.ipc.invoke(APP_CHANNELS.providersDelete, PROVIDER_EDITOR_ID, {
      id: 'codex'
    }) as ProviderConfig[]

    // The built-in is back, not gone: that is what "Auf Preset zurücksetzen" is.
    expect(configs.map((entry) => entry.id)).toEqual(['claude', 'codex'])
    expect(configs[1]!.command).toBe('codex')
    expect(h.broadcasts.at(-1)?.channel).toBe(APP_CHANNELS.eventProviders)
  })

  it('re-probes health after a write instead of showing the stale answer', async () => {
    await h.ipc.invoke(APP_CHANNELS.providersList, PANEL_ID)
    expect(h.health).toHaveBeenCalledTimes(1)

    h.ipc.invoke(APP_CHANNELS.providersSave, PANEL_ID, custom)
    await h.ipc.invoke(APP_CHANNELS.providersList, PANEL_ID)
    // A provider that was just created has no cached `--version` answer; the
    // cached one would show it as "nicht startbar".
    expect(h.health).toHaveBeenCalledTimes(2)
  })

  it('rejects an invalid descriptor instead of writing half a launch recipe', () => {
    expect(() =>
      h.ipc.invoke(APP_CHANNELS.providersSave, PROVIDER_EDITOR_ID, { id: 'x', command: '' })
    ).toThrow()
    expect(h.store.effectiveProviders().map((entry) => entry.id)).toEqual(['claude', 'codex'])
    expect(h.broadcasts).toEqual([])
  })

  it('refuses a delete without an id', () => {
    expect(() => h.ipc.invoke(APP_CHANNELS.providersDelete, PANEL_ID, {})).toThrow(
      /missing provider id/
    )
  })

  it('is closed to a CLI window on every channel', () => {
    for (const channel of [
      APP_CHANNELS.providersList,
      APP_CHANNELS.providersSave,
      APP_CHANNELS.providersDelete
    ]) {
      expect(() => h.ipc.invoke(channel, CLI_ID, custom)).toThrow(/not a panel or editor/)
    }
  })
})

describe('the provider editor window', () => {
  it('opens empty from the panel and by id from the profile editor', () => {
    h.ipc.invoke(APP_CHANNELS.providerEditorOpen, PANEL_ID, {})
    // "+ Eigener Provider …" and the pencil both live in the profile editor.
    h.ipc.invoke(APP_CHANNELS.providerEditorOpen, EDITOR_ID, { providerId: 'claude' })
    expect(h.providerEditorsOpened).toEqual([undefined, 'claude'])
  })

  it('is not openable from a CLI window', () => {
    expect(() => h.ipc.invoke(APP_CHANNELS.providerEditorOpen, CLI_ID, {})).toThrow(
      /not a panel or editor/
    )
  })

  it('lets only a provider editor close itself', () => {
    h.ipc.send(APP_CHANNELS.providerEditorClose, EDITOR_ID)
    h.ipc.send(APP_CHANNELS.providerEditorClose, PANEL_ID)
    expect(h.providerEditorsClosed).toEqual([])

    h.ipc.send(APP_CHANNELS.providerEditorClose, PROVIDER_EDITOR_ID)
    expect(h.providerEditorsClosed).toEqual([PROVIDER_EDITOR_ID])
  })

  it('may read the data it needs — providers, profiles and models', async () => {
    expect(await h.ipc.invoke(APP_CHANNELS.providersList, PROVIDER_EDITOR_ID)).toHaveLength(2)
    expect(h.ipc.invoke(APP_CHANNELS.profilesList, PROVIDER_EDITOR_ID)).toHaveLength(2)
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
    h.ipc.invoke(APP_CHANNELS.workspacesFocus, PANEL_ID, { workspaceId: 'w1' })
    h.ipc.invoke(APP_CHANNELS.workspacesCloseAgent, PANEL_ID, { agentId: 'w1-orch' })

    expect(h.directory.started).toEqual([{ profileId: 'p1' }])
    expect(h.directory.stopped).toEqual(['w1'])
    expect(h.directory.focused).toEqual(['w1-orch'])
    expect(h.directory.focusedWorkspaces).toEqual(['w1'])
    expect(h.directory.closedAgents).toEqual(['w1-orch'])
    expect(h.broadcasts.map((entry) => entry.channel)).toEqual([
      APP_CHANNELS.eventWorkspaces,
      APP_CHANNELS.eventWorkspaces,
      APP_CHANNELS.eventWorkspaces
    ])
  })

  it('passes a goal through to the directory and treats a blank one as absent (H2)', async () => {
    await h.ipc.invoke(APP_CHANNELS.workspacesStart, PANEL_ID, {
      profileId: 'p1',
      goal: '  Fix the login bug  '
    })
    await h.ipc.invoke(APP_CHANNELS.workspacesStart, PANEL_ID, { profileId: 'p1', goal: '   ' })

    expect(h.directory.started).toEqual([
      { profileId: 'p1', goal: 'Fix the login bug' },
      { profileId: 'p1' }
    ])
  })

  it('answers an agent question over the directory (H1) — panel only, all ids required', async () => {
    await h.ipc.invoke(APP_CHANNELS.workspacesAnswerQuestion, PANEL_ID, {
      workspaceId: 'w1',
      agentId: 'a1',
      questionId: 'q1',
      text: 'Use bcrypt.'
    })
    expect(h.directory.answered).toEqual([
      { workspaceId: 'w1', agentId: 'a1', questionId: 'q1', text: 'Use bcrypt.' }
    ])

    for (const broken of [
      { agentId: 'a1', questionId: 'q1', text: 'x' },
      { workspaceId: 'w1', questionId: 'q1', text: 'x' },
      { workspaceId: 'w1', agentId: 'a1', text: 'x' },
      { workspaceId: 'w1', agentId: 'a1', questionId: 'q1', text: '  ' }
    ]) {
      await expect(
        Promise.resolve(h.ipc.invoke(APP_CHANNELS.workspacesAnswerQuestion, PANEL_ID, broken))
      ).rejects.toThrow(/rejected/)
    }
    expect(h.directory.answered).toHaveLength(1)

    expect(() =>
      h.ipc.invoke(APP_CHANNELS.workspacesAnswerQuestion, CLI_ID, {
        workspaceId: 'w1',
        agentId: 'a1',
        questionId: 'q1',
        text: 'x'
      })
    ).toThrow(/not the panel/)
  })

  it('steers a workspace over user_message (D2) — panel only, text required', async () => {
    await h.ipc.invoke(APP_CHANNELS.workspacesUserMessage, PANEL_ID, {
      workspaceId: 'w1',
      text: '  Focus on the parser.  '
    })
    expect(h.directory.userMessages).toEqual([{ workspaceId: 'w1', text: 'Focus on the parser.' }])

    await expect(
      Promise.resolve(
        h.ipc.invoke(APP_CHANNELS.workspacesUserMessage, PANEL_ID, { workspaceId: 'w1', text: ' ' })
      )
    ).rejects.toThrow(/missing text/)
    expect(() =>
      h.ipc.invoke(APP_CHANNELS.workspacesUserMessage, CLI_ID, { workspaceId: 'w1', text: 'x' })
    ).toThrow(/not the panel/)
  })

  it('promotes an agent branch on explicit click (E1) — panel only', async () => {
    await h.ipc.invoke(APP_CHANNELS.workspacesPromoteAgent, PANEL_ID, {
      workspaceId: 'w1',
      agentId: 'a1'
    })
    expect(h.directory.promoted).toEqual([{ workspaceId: 'w1', agentId: 'a1' }])
    await expect(
      Promise.resolve(h.ipc.invoke(APP_CHANNELS.workspacesPromoteAgent, PANEL_ID, { agentId: 'a1' }))
    ).rejects.toThrow(/missing workspace id/)
    expect(() =>
      h.ipc.invoke(APP_CHANNELS.workspacesPromoteAgent, CLI_ID, { workspaceId: 'w1', agentId: 'a1' })
    ).toThrow(/not the panel/)
  })

  it('rejects a focus-workspace call without a workspace id', () => {
    expect(() => h.ipc.invoke(APP_CHANNELS.workspacesFocus, PANEL_ID, {})).toThrow(
      /missing workspace id/
    )
  })

  it('rejects a close-agent call without an agent id', () => {
    expect(() => h.ipc.invoke(APP_CHANNELS.workspacesCloseAgent, PANEL_ID, {})).toThrow(
      /missing agent id/
    )
  })

  it('surfaces a refusing directory instead of swallowing it', async () => {
    const refuse = (): never => {
      throw new Error('Workspace-Manager ist noch nicht verdrahtet.')
    }
    const failing = harness({
      directory: {
        list: () => [],
        start: refuse,
        stop() {},
        answerQuestion: async () => refuse(),
        postUserMessage: refuse,
        promoteAgentBranch: async () => refuse(),
        focusAgent() {},
        closeAgentWindow() {},
        focusWorkspace() {},
        listStaleWorktrees: async () => refuse(),
        removeWorktree: async () => refuse()
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

describe('worktree cleanup', () => {
  it('lists a profile’s stale worktrees for the panel only', async () => {
    await expect(
      Promise.resolve(h.ipc.invoke(APP_CHANNELS.worktreesList, PANEL_ID, { profileId: 'p1' }))
    ).resolves.toEqual(h.directory.staleWorktrees)
    expect(() => h.ipc.invoke(APP_CHANNELS.worktreesList, EDITOR_ID, { profileId: 'p1' })).toThrow(
      /not the panel/
    )
    expect(() => h.ipc.invoke(APP_CHANNELS.worktreesList, PANEL_ID, {})).toThrow(
      /missing profile id/
    )
  })

  it('removes one worktree and answers with the refreshed list', async () => {
    const path = '/repo/.vertragus/worktrees/old-1'
    await expect(
      Promise.resolve(h.ipc.invoke(APP_CHANNELS.worktreesRemove, PANEL_ID, { profileId: 'p1', path }))
    ).resolves.toEqual([])
    expect(h.directory.removedWorktrees).toEqual([{ profileId: 'p1', path }])
  })

  it('refuses a removal without profile or path — never a guessed default', () => {
    expect(() =>
      h.ipc.invoke(APP_CHANNELS.worktreesRemove, PANEL_ID, { path: '/x' })
    ).toThrow(/missing profile id/)
    expect(() =>
      h.ipc.invoke(APP_CHANNELS.worktreesRemove, PANEL_ID, { profileId: 'p1' })
    ).toThrow(/missing worktree path/)
    expect(() =>
      h.ipc.invoke(APP_CHANNELS.worktreesRemove, CLI_ID, { profileId: 'p1', path: '/x' })
    ).toThrow(/not the panel/)
  })
})

describe('retro', () => {
  const learning = (id: string, profileId?: string): ModelLearning => ({
    id,
    providerId: 'claude',
    model: 'sonnet',
    kind: 'strength',
    insight: 'stark bei UI',
    source: 'orchestrator',
    ...(profileId ? { profileId } : {}),
    observations: 1,
    createdAt: 1,
    updatedAt: 1
  })

  const retro = (id: string, profileId: string): RunRetro => ({
    id,
    workspaceId: `ws-${id}`,
    workspaceName: 'Paradiso',
    profileId,
    summary: '',
    stats: [],
    createdAt: 1,
    endedAt: 2
  })

  it('lists retros for the panel only, filtered by profile when asked', () => {
    h.store.retros = [retro('r1', 'p1'), retro('r2', 'p2')]
    expect(h.ipc.invoke(APP_CHANNELS.retroList, PANEL_ID, {})).toHaveLength(2)
    expect(h.ipc.invoke(APP_CHANNELS.retroList, PANEL_ID, { profileId: 'p2' })).toEqual([
      retro('r2', 'p2')
    ])
    expect(() => h.ipc.invoke(APP_CHANNELS.retroList, EDITOR_ID, {})).toThrow(/not the panel/)
  })

  it('filters learnings softly — profile-less entries show everywhere', () => {
    h.store.learnings = [learning('l1'), learning('l2', 'p1'), learning('l3', 'p2')]
    const forP1 = h.ipc.invoke(APP_CHANNELS.retroLearnings, PANEL_ID, {
      profileId: 'p1'
    }) as ModelLearning[]
    expect(forP1.map((entry) => entry.id)).toEqual(['l1', 'l2'])
    expect(h.ipc.invoke(APP_CHANNELS.retroLearnings, PANEL_ID, {})).toHaveLength(3)
    expect(() => h.ipc.invoke(APP_CHANNELS.retroLearnings, CLI_ID, {})).toThrow(/not the panel/)
  })

  it('deletes one learning by id and answers with the refreshed list', () => {
    h.store.learnings = [learning('l1'), learning('l2')]
    const remaining = h.ipc.invoke(APP_CHANNELS.retroDeleteLearning, PANEL_ID, {
      id: 'l1'
    }) as ModelLearning[]
    expect(remaining.map((entry) => entry.id)).toEqual(['l2'])
    expect(() => h.ipc.invoke(APP_CHANNELS.retroDeleteLearning, PANEL_ID, {})).toThrow(
      /missing learning id/
    )
    expect(() => h.ipc.invoke(APP_CHANNELS.retroDeleteLearning, EDITOR_ID, { id: 'l2' })).toThrow(
      /not the panel/
    )
  })
})

describe('settings and windows', () => {
  it('returns only the settings a window shows', () => {
    expect(h.ipc.invoke(APP_CHANNELS.settingsGet, PANEL_ID)).toEqual({
      yoloMaster: true,
      agentPolicy: 'yolo',
      hideAllHotkey: 'Control+Alt+V',
      locale: 'de',
      theme: 'dark',
      autostart: false,
      updateChannel: 'main',
      autostartSupported: true,
      appearance: DEFAULT_APPEARANCE
    })
    // Never the app's own bookkeeping — model memory and panel bounds are
    // written by the app and have no form.
    expect(h.ipc.invoke(APP_CHANNELS.settingsGet, PANEL_ID)).not.toHaveProperty('modelMemory')
  })

  it('answers the appearance in EVERY window — a CLI window included', () => {
    // The one deliberate hole in the window-type guard: a terminal window is
    // the surface standing over the wallpaper, so it has to be able to ask how
    // see-through it should be. Everything else on `settings:get` stays shut.
    expect(h.ipc.invoke(APP_CHANNELS.settingsAppearance, CLI_ID)).toEqual(DEFAULT_APPEARANCE)
    expect(h.ipc.invoke(APP_CHANNELS.settingsAppearance, PANEL_ID)).toEqual(DEFAULT_APPEARANCE)
    expect(() => h.ipc.invoke(APP_CHANNELS.settingsGet, CLI_ID)).toThrow(/rejected/)
  })

  it('stores an appearance write, clamps it and pushes it to every window', async () => {
    h.broadcasts.length = 0
    const next = (await h.ipc.invoke(APP_CHANNELS.settingsSet, SETTINGS_ID, {
      key: 'appearance',
      // hoverOpacity below restOpacity, and a surface value past its range:
      // the schema clamps rather than refusing — a slider is not a typo.
      value: { translucent: true, restOpacity: 0.8, hoverOpacity: 0.5, surfaceTransparency: 4 }
    })) as PanelSettings

    expect(next.appearance).toEqual({
      translucent: true,
      restOpacity: 0.8,
      hoverOpacity: 0.8,
      focusOpacity: 1,
      surfaceTransparency: 1
    })
    expect(h.store.settings.ui.appearance).toEqual(next.appearance)
    // The theme and the language it shares its `ui` section with are untouched.
    expect(h.store.settings.ui).toMatchObject({ theme: 'dark', locale: 'de' })
    expect(h.broadcasts).toEqual([
      { channel: APP_CHANNELS.eventSettings, payload: next },
      { channel: APP_CHANNELS.eventAppearance, payload: next.appearance }
    ])
  })

  it('takes the master switch without touching the stored sliders', async () => {
    await h.ipc.invoke(APP_CHANNELS.settingsSet, SETTINGS_ID, {
      key: 'appearance',
      value: { ...DEFAULT_APPEARANCE, restOpacity: 0.4, translucent: false }
    })
    const stored = h.store.settings.ui.appearance
    expect(stored.translucent).toBe(false)
    // Switching transparency off must not forget what the user had set: the
    // opaque mode is resolved when the CSS variables are built, not by
    // flattening the values in the store.
    expect(stored.restOpacity).toBe(0.4)
  })

  it('toggles the yolo master', () => {
    expect(h.ipc.invoke(APP_CHANNELS.settingsYolo, PANEL_ID, { enabled: false })).toMatchObject({
      yoloMaster: false,
      // D4: the coarse toggle lands on the ask-user tier, never on a stale one.
      agentPolicy: 'ask-user'
    })
    expect(h.store.settings.yoloMaster).toBe(false)
  })

  it('writes the D4 tier from the settings window and mirrors the boolean', async () => {
    const next = (await h.ipc.invoke(APP_CHANNELS.settingsSet, SETTINGS_ID, {
      key: 'agentPolicy',
      value: 'ask-orchestrator'
    })) as PanelSettings
    expect(next.agentPolicy).toBe('ask-orchestrator')
    expect(next.yoloMaster).toBe(false)
    expect(h.store.settings.agentPolicy).toBe('ask-orchestrator')

    await expect(
      h.ipc.invoke(APP_CHANNELS.settingsSet, SETTINGS_ID, { key: 'agentPolicy', value: 'full-send' })
    ).rejects.toThrow(/agentPolicy expects/)
  })

  it('broadcasts every settings write so the other windows follow', async () => {
    h.broadcasts.length = 0
    const yolo = h.ipc.invoke(APP_CHANNELS.settingsYolo, PANEL_ID, { enabled: false })
    // Two pushes per write: the whole settings object to the app windows, and
    // the appearance alone on the channel CLI windows are allowed to hear.
    expect(h.broadcasts).toEqual([
      { channel: APP_CHANNELS.eventSettings, payload: yolo },
      { channel: APP_CHANNELS.eventAppearance, payload: DEFAULT_APPEARANCE }
    ])

    h.broadcasts.length = 0
    const locale = await h.ipc.invoke(APP_CHANNELS.settingsSet, SETTINGS_ID, {
      key: 'locale',
      value: 'en'
    })
    // This is the language switch: the panel and both editors change with the
    // settings window instead of waiting for their next read.
    expect(h.broadcasts).toEqual([
      { channel: APP_CHANNELS.eventSettings, payload: locale },
      { channel: APP_CHANNELS.eventAppearance, payload: DEFAULT_APPEARANCE }
    ])
    expect(locale).toMatchObject({ locale: 'en' })
  })

  it('broadcasts nothing when the write was rejected', async () => {
    h.broadcasts.length = 0
    await expect(
      h.ipc.invoke(APP_CHANNELS.settingsSet, SETTINGS_ID, { key: 'autostart', value: 'ja' })
    ).rejects.toThrow(/expects a boolean/)
    expect(() => h.ipc.invoke(APP_CHANNELS.settingsYolo, PANEL_ID, { enabled: 'yes' })).toThrow()
    expect(h.broadcasts).toEqual([])
  })

  it('rejects a yolo payload that is not a boolean', () => {
    expect(() => h.ipc.invoke(APP_CHANNELS.settingsYolo, PANEL_ID, { enabled: 'yes' })).toThrow(
      /expected a boolean/
    )
  })

  it('minimizes the panel itself without touching hide-all', () => {
    h.ipc.invoke(APP_CHANNELS.windowsMinimizePanel, PANEL_ID)
    expect(h.panelMinimizes).toBe(1)
    // The two verbs stay apart: the panel's − must not clear the agents away.
    expect(h.hidden).toBe(0)
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

describe('the settings window', () => {
  it('opens from the panel — and only from the panel', () => {
    h.ipc.invoke(APP_CHANNELS.settingsWindowOpen, PANEL_ID)
    expect(h.settingsOpened).toBe(1)

    for (const sender of [CLI_ID, EDITOR_ID, SETTINGS_ID]) {
      expect(() => h.ipc.invoke(APP_CHANNELS.settingsWindowOpen, sender)).toThrow(/rejected/)
    }
    expect(h.settingsOpened).toBe(1)
  })

  it('lets only itself close itself', () => {
    h.ipc.send(APP_CHANNELS.settingsWindowClose, PANEL_ID)
    h.ipc.send(APP_CHANNELS.settingsWindowClose, CLI_ID)
    expect(h.settingsClosed).toBe(0)

    h.ipc.send(APP_CHANNELS.settingsWindowClose, SETTINGS_ID)
    expect(h.settingsClosed).toBe(1)
  })

  it('may read the shared app data the profile editor reads', () => {
    expect(h.ipc.invoke(APP_CHANNELS.profilesList, SETTINGS_ID)).toHaveLength(2)
    expect(h.ipc.invoke(APP_CHANNELS.settingsGet, SETTINGS_ID)).toMatchObject({ locale: 'de' })
  })
})

describe('settings:set', () => {
  it('accepts writes from the panel and from the settings window only', async () => {
    await expect(
      h.ipc.invoke(APP_CHANNELS.settingsSet, SETTINGS_ID, { key: 'theme', value: 'light' })
    ).resolves.toMatchObject({ theme: 'light' })
    await expect(
      h.ipc.invoke(APP_CHANNELS.settingsSet, PANEL_ID, { key: 'locale', value: 'en' })
    ).resolves.toMatchObject({ locale: 'en' })

    for (const sender of [CLI_ID, EDITOR_ID]) {
      expect(() =>
        h.ipc.invoke(APP_CHANNELS.settingsSet, sender, { key: 'theme', value: 'light' })
      ).toThrow(/not the panel or the settings window/)
    }
  })

  it('refuses every key that is not on the small allow-list', async () => {
    // `modelMemory` and `ui` are written by the app itself; a renderer that
    // could set them could corrupt state no form ever shows.
    for (const key of ['modelMemory', 'ui', 'yoloMaster', 'profiles', '__proto__', undefined]) {
      await expect(
        h.ipc.invoke(APP_CHANNELS.settingsSet, SETTINGS_ID, { key, value: 1 })
      ).rejects.toThrow(/not user-writable/)
    }
    expect(WRITABLE_SETTINGS).toEqual([
      'hideAllHotkey',
      'autostart',
      'updateChannel',
      'theme',
      'locale',
      'appearance',
      'agentPolicy'
    ])
  })

  it('takes a new hotkey immediately instead of at the next boot', async () => {
    const next = (await h.ipc.invoke(APP_CHANNELS.settingsSet, SETTINGS_ID, {
      key: 'hideAllHotkey',
      value: 'Control+Shift+H'
    })) as PanelSettings

    expect(h.registeredHotkeys).toEqual(['Control+Shift+H'])
    expect(h.store.settings.hideAllHotkey).toBe('Control+Shift+H')
    expect(next.hideAllHotkey).toBe('Control+Shift+H')
    expect(next.hideAllHotkeyError).toBeUndefined()
  })

  it('stores a refused hotkey and hands the reason back for the form', async () => {
    h.hotkeyRegisters = false
    const next = (await h.ipc.invoke(APP_CHANNELS.settingsSet, SETTINGS_ID, {
      key: 'hideAllHotkey',
      value: 'Control+Alt+Delete'
    })) as PanelSettings

    // Stored: the field must show what is actually saved …
    expect(h.store.settings.hideAllHotkey).toBe('Control+Alt+Delete')
    // … and the reason travels with it instead of into a console nobody reads.
    expect(next.hideAllHotkeyError).toContain('belegt')
  })

  it('rejects an empty hotkey at the store, before anything is registered', async () => {
    // The schema is the gate; a hotkey that can never be registered is a write
    // error, not a status.
    h.store.setSetting = () => {
      throw new Error('hideAllHotkey darf nicht leer sein')
    }
    await expect(
      h.ipc.invoke(APP_CHANNELS.settingsSet, SETTINGS_ID, { key: 'hideAllHotkey', value: '' })
    ).rejects.toThrow(/leer/)
    expect(h.registeredHotkeys).toEqual([])
  })

  it('writes the login item only where it means something', async () => {
    await h.ipc.invoke(APP_CHANNELS.settingsSet, SETTINGS_ID, { key: 'autostart', value: true })
    expect(h.autostartWrites).toEqual([true])
    expect(h.store.settings.autostart).toBe(true)

    // In a dev run the entry would point at the Electron binary: stored, but
    // never registered, and the window is told the switch is inert.
    h.autostartSupported = false
    const next = (await h.ipc.invoke(APP_CHANNELS.settingsSet, SETTINGS_ID, {
      key: 'autostart',
      value: false
    })) as PanelSettings
    expect(h.autostartWrites).toEqual([true])
    expect(next.autostartSupported).toBe(false)
    expect(next.autostart).toBe(false)
  })

  it('rejects an autostart payload that is not a boolean', async () => {
    await expect(
      h.ipc.invoke(APP_CHANNELS.settingsSet, SETTINGS_ID, { key: 'autostart', value: 'ja' })
    ).rejects.toThrow(/expects a boolean/)
  })

  it('routes the update channel through the updater, which persists it once', async () => {
    const next = (await h.ipc.invoke(APP_CHANNELS.settingsSet, SETTINGS_ID, {
      key: 'updateChannel',
      value: 'stable'
    })) as PanelSettings

    expect(h.channelWrites).toEqual(['stable'])
    expect(next.updateChannel).toBe('stable')
  })

  it('rejects a channel nobody publishes to', async () => {
    await expect(
      h.ipc.invoke(APP_CHANNELS.settingsSet, SETTINGS_ID, { key: 'updateChannel', value: 'nightly' })
    ).rejects.toThrow(/main or stable/)
    expect(h.channelWrites).toEqual([])
  })

  it('patches theme and locale into the ui object without losing the other half', async () => {
    await h.ipc.invoke(APP_CHANNELS.settingsSet, SETTINGS_ID, { key: 'theme', value: 'light' })
    const next = (await h.ipc.invoke(APP_CHANNELS.settingsSet, SETTINGS_ID, {
      key: 'locale',
      value: 'en'
    })) as PanelSettings

    expect(next).toMatchObject({ theme: 'light', locale: 'en' })
    expect(h.store.settings.ui).toEqual({
      theme: 'light',
      locale: 'en',
      appearance: DEFAULT_APPEARANCE
    })
  })
})

describe('self-update', () => {
  it('serves the current state to the panel and the settings window', () => {
    h.pushUpdate({ status: 'downloaded', availableVersion: '1.4.0' })

    expect(h.ipc.invoke(APP_CHANNELS.updatesGet, PANEL_ID)).toMatchObject({
      status: 'downloaded',
      availableVersion: '1.4.0'
    })
    expect(h.ipc.invoke(APP_CHANNELS.updatesGet, SETTINGS_ID)).toMatchObject({
      status: 'downloaded'
    })
    expect(() => h.ipc.invoke(APP_CHANNELS.updatesGet, CLI_ID)).toThrow(/rejected/)
  })

  it('pushes every state change to the windows that draw the badge', () => {
    h.pushUpdate({ status: 'downloading', progress: 40 })
    h.pushUpdate({ status: 'downloaded', availableVersion: '1.4.0', progress: undefined })

    const pushed = h.broadcasts.filter((entry) => entry.channel === APP_CHANNELS.eventUpdate)
    expect(pushed.map((entry) => (entry.payload as UpdateStatePayload).status)).toEqual([
      'downloading',
      'downloaded'
    ])
  })

  it('installs on demand — never on its own', async () => {
    h.pushUpdate({ status: 'downloaded' })
    expect(h.installs).toBe(0)

    await h.ipc.invoke(APP_CHANNELS.updatesInstall, PANEL_ID)
    expect(h.installs).toBe(1)

    expect(() => h.ipc.invoke(APP_CHANNELS.updatesInstall, CLI_ID)).toThrow(/rejected/)
    expect(h.installs).toBe(1)
  })

  it('runs a manual check for the settings window', async () => {
    await h.ipc.invoke(APP_CHANNELS.updatesCheck, SETTINGS_ID)
    expect(h.updateChecks).toBe(1)
  })

  it('stops pushing once disposed', () => {
    h.app.dispose()
    h.broadcasts.length = 0
    h.pushUpdate({ status: 'downloaded' })
    expect(h.broadcasts).toEqual([])
  })
})

describe('quitting the app', () => {
  it('counts the agents a quit would kill, ignoring dead workspaces', () => {
    expect(runningAgentCount([])).toBe(0)
    expect(runningAgentCount([workspace('w1'), workspace('w2', false)])).toBe(1)

    const busy = workspace('w3')
    busy.agents = [
      ...busy.agents,
      { agentId: 'a', name: 'Arlecchino', roleId: 'worker', roleColor: '#000', state: 'waiting' },
      { agentId: 'b', name: 'Brighella', roleId: 'worker', roleColor: '#000', state: 'stopped' }
    ]
    expect(runningAgentCount([busy])).toBe(2)
  })

  it('words the confirmation for one agent and for many', () => {
    expect(quitConfirmationText(1).message).toBe('1 Agent läuft noch — Vertragus beenden?')
    expect(quitConfirmationText(4).message).toBe('4 Agenten laufen noch — Vertragus beenden?')
    expect(quitConfirmationText(4).detail).toBe('Alle Agenten-Prozesse werden gestoppt.')
  })

  it('asks before killing running agents and quits when confirmed', async () => {
    await expect(h.ipc.invoke(APP_CHANNELS.appQuit, PANEL_ID)).resolves.toBe(true)
    expect(h.quitPrompts).toEqual([1])
    expect(h.quits).toBe(1)
  })

  it('does not quit when the user cancels', async () => {
    h.confirmQuit = false
    await expect(h.ipc.invoke(APP_CHANNELS.appQuit, PANEL_ID)).resolves.toBe(false)
    expect(h.quitPrompts).toEqual([1])
    expect(h.quits).toBe(0)
  })

  it('quits straight away when nothing is running', async () => {
    const idle = harness({ directory: { ...h.directory, list: () => [workspace('w1', false)] } })
    await expect(idle.ipc.invoke(APP_CHANNELS.appQuit, PANEL_ID)).resolves.toBe(true)
    expect(idle.quitPrompts).toEqual([])
    expect(idle.quits).toBe(1)
  })

  it('is refused for every window that is not the panel', async () => {
    for (const sender of [EDITOR_ID, CLI_ID]) {
      expect(() => h.ipc.invoke(APP_CHANNELS.appQuit, sender)).toThrow(/not the panel window/)
    }
    expect(h.quits).toBe(0)
  })
})

describe('sender authorization', () => {
  const panelOnly = [
    APP_CHANNELS.workspacesList,
    APP_CHANNELS.workspacesStart,
    APP_CHANNELS.workspacesStop,
    APP_CHANNELS.workspacesFocusAgent,
    APP_CHANNELS.workspacesFocus,
    APP_CHANNELS.workspacesCloseAgent,
    APP_CHANNELS.settingsYolo,
    APP_CHANNELS.windowsHideAll,
    APP_CHANNELS.windowsMinimizePanel,
    APP_CHANNELS.appQuit
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
    expect(payload.locale).toBe('de')
    expect(payload.theme).toBe('dark')
    expect(payload.selectingDisplay).toBe(false)
    expect(payload.displays.map((display) => display.id)).toEqual([11, 22])
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
    expect(saved.zones?.targetDisplayId).toBe(11)
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
      expect(() =>
        h.ipc.invoke(APP_CHANNELS.zonesPickDisplay, sender, { displayId: 11 })
      ).toThrow(/not a zone overlay window/)
    }
    // The fire-and-forget channels ignore strangers instead of throwing.
    h.ipc.send(APP_CHANNELS.zonesDraft, CLI_ID, { zones: [] })
    h.ipc.send(APP_CHANNELS.zonesCancel, CLI_ID)
    expect(h.zonesClosed).toBe(0)
    expect(h.pickedDisplays).toEqual([])
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

  it('pins the profile to the chosen screen and returns the editor payload', () => {
    const payload = h.ipc.invoke(APP_CHANNELS.zonesPickDisplay, OVERLAY_A_ID, {
      displayId: 22
    }) as ZoneEditorPayload

    expect(h.pickedDisplays).toEqual([22])
    expect(payload.displayId).toBe(22)
    expect(payload.selectingDisplay).toBe(false)
    expect(payload.roles.map((role) => role.roleId)).toEqual(['orchestrator', 'worker'])
    expect(h.store.getProfiles().find((entry) => entry.id === 'p1')!.zones?.targetDisplayId).toBe(
      22
    )
    expect(h.broadcasts.at(-1)?.channel).toBe(APP_CHANNELS.eventProfiles)
  })

  it('refuses a pick for a display that is not attached', () => {
    expect(() =>
      h.ipc.invoke(APP_CHANNELS.zonesPickDisplay, OVERLAY_A_ID, { displayId: 99 })
    ).toThrow(/unknown display/)
    expect(h.pickedDisplays).toEqual([])
    expect(h.store.getProfiles().find((entry) => entry.id === 'p1')!.zones).toBeUndefined()
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

/**
 * The gear in a profile row was reported as "not clickable". The click path is
 * panel → `profileEditor:open` → `openProfileEditorWindow`, and the only place
 * it could break silently is the production registration: `registerAppIpc` is a
 * singleton, so a SECOND caller would decide which workspace directory the
 * panel talks to — and any caller that landed before the WorkspaceManager
 * exists would pin the refusing stub for the rest of the run. These tests nail
 * both ends of that chain down.
 */
describe('production registration', () => {
  /** Pull a handler out of the mocked ipcMain and call it as a window would. */
  function invokeRegistered(channel: string, senderId: number, payload?: unknown): unknown {
    const call = vi
      .mocked(ipcMain.handle)
      .mock.calls.findLast((entry) => entry[0] === channel)
    if (!call) throw new Error(`no handler registered for ${channel}`)
    return (call[1] as unknown as Listener)({ sender: { id: senderId } }, payload as never)
  }

  beforeEach(() => {
    disposeAppIpc()
    vi.mocked(ipcMain.handle).mockClear()
    vi.mocked(isPanelWindowSender).mockReturnValue(true)
    vi.mocked(settings).mockReturnValue({
      getProfiles: () => []
    } as unknown as ReturnType<typeof settings>)
  })

  afterEach(() => {
    disposeAppIpc()
    vi.mocked(isPanelWindowSender).mockReturnValue(false)
  })

  it('opens the profile editor for a gear click from the panel', () => {
    registerAppIpc()
    invokeRegistered(APP_CHANNELS.profileEditorOpen, PANEL_ID, { profileId: 'p1' })
    expect(openProfileEditorWindow).toHaveBeenCalledWith('p1')
  })

  it('registers every channel exactly once', () => {
    registerAppIpc()
    const channels = vi.mocked(ipcMain.handle).mock.calls.map((entry) => entry[0])
    expect(new Set(channels).size).toBe(channels.length)
  })

  it('keeps the FIRST directory when someone registers a second time', async () => {
    const real: WorkspaceDirectory = {
      list: () => [workspace('w1')],
      start: vi.fn(),
      stop: vi.fn(),
      answerQuestion: vi.fn(async () => {}),
      postUserMessage: vi.fn(),
      promoteAgentBranch: vi.fn(async () => {}),
      focusAgent: vi.fn(),
      closeAgentWindow: vi.fn(),
      focusWorkspace: vi.fn(),
      listStaleWorktrees: vi.fn(async () => []),
      removeWorktree: vi.fn(async () => [])
    }
    const second: WorkspaceDirectory = {
      list: () => [],
      start: vi.fn(),
      stop: vi.fn(),
      answerQuestion: vi.fn(async () => {}),
      postUserMessage: vi.fn(),
      promoteAgentBranch: vi.fn(async () => {}),
      focusAgent: vi.fn(),
      closeAgentWindow: vi.fn(),
      focusWorkspace: vi.fn(),
      listStaleWorktrees: vi.fn(async () => []),
      removeWorktree: vi.fn(async () => [])
    }
    const first = registerAppIpc(real)
    expect(registerAppIpc(second)).toBe(first)

    // Still the real manager behind the panel's channels, and no duplicate
    // ipcMain.handle for a channel (which Electron would throw on).
    expect(invokeRegistered(APP_CHANNELS.workspacesList, PANEL_ID)).toHaveLength(1)
    await expect(
      invokeRegistered(APP_CHANNELS.workspacesStart, PANEL_ID, { profileId: 'p1' })
    ).resolves.toBeUndefined()
    expect(real.start).toHaveBeenCalledWith('p1')
    expect(second.start).not.toHaveBeenCalled()
  })
})

describe('preload parity', () => {
  it('uses exactly the channel names main registers', () => {
    const source = readFileSync(join(__dirname, '../preload/index.ts'), 'utf8')
    // The remote-access channels are registered separately (main/remote/ipc.ts)
    // but still cross this bridge, so they count toward parity too.
    const expected = new Set([...Object.values(APP_CHANNELS), ...Object.values(REMOTE_CHANNELS)])
    for (const channel of expected) {
      expect(source).toContain(`'${channel}'`)
    }
    const found = [
      ...source.matchAll(
        /'((?:profiles|roles|providers|models|workspaces|worktrees|retro|settings|settingsWindow|updates|windows|app|dialog|profileEditor|providerEditor|zones|remote|ev):[a-zA-Z]+)'/g
      )
    ].map((match) => match[1])
    expect(new Set(found)).toEqual(expected)
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
