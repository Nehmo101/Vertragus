import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The production wiring at the bottom of appIpc.ts reaches into Electron, the
 * settings store (electron-store) and three window registries. The contract
 * under test is `createAppIpc`, which takes all of that as a host — so those
 * modules are mocked away wholesale and never actually run here.
 */
vi.mock('electron', () => ({
  app: { quit: vi.fn(), getPath: vi.fn(() => '/userData') },
  clipboard: {
    readImage: vi.fn(() => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) }))
  },
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn(), removeAllListeners: vi.fn() },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn(), showMessageBox: vi.fn() },
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
vi.mock('@main/providers/authStatus', () => ({ checkAllProviderAuth: vi.fn() }))
vi.mock('@main/windows/cliWindow', () => ({
  focusCliWindow: vi.fn(),
  listCliWindows: vi.fn(() => []),
  listCliTabWebContents: vi.fn(() => [])
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
vi.mock('@main/windows/timelineWindow', () => ({
  isTimelineWindowSender: vi.fn(() => null),
  openTimelineWindow: vi.fn(),
  closeTimelineWindow: vi.fn(),
  getTimelineWindow: vi.fn(() => null),
  listTimelineWindows: vi.fn(() => [])
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
  reRegisterHideAllShortcut: vi.fn(() => ({ hotkey: 'Control+Alt+V', registered: true })),
  setHideAllRestoreWorkspace: vi.fn()
}))
vi.mock('@main/workspace/listRuns', () => ({
  listRuns: vi.fn(async () => []),
  readRun: vi.fn(async () => undefined)
}))

import { ipcMain } from 'electron'
import { isPanelWindowSender } from '@main/windows/panel'
import { openProfileEditorWindow } from '@main/windows/profileEditor'
import { settings } from '@main/store/settings'
import {
  APP_CHANNELS,
  agentCurrentTaskFields,
  capTimelineEvents,
  createAppIpc,
  TIMELINE_EVENTS_MAX,
  createStubWorkspaceDirectory,
  disposeAppIpc,
  mergeMcpServersPatch,
  PROVIDER_HEALTH_TTL_MS,
  quitConfirmationText,
  registerAppIpc,
  runningAgentCount,
  toPanelSettings,
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
import { BROWSER_EXTENSION_CHANNELS } from './browserExtension/ipc'
import type { MinimalIpcMain } from './ipc'
import type { WorkspaceSummary as PreloadWorkspaceSummary } from '../preload'
import { profileSchema, type Profile, type RoleTemplate } from '@shared/schema/profile'
import {
  packProfileBundle,
  serializeProfileBundle
} from '@shared/schema/profileBundle'
import type { ModelLearning, RepoNote, RunRetro } from '@shared/schema/retro'
import { DEFAULT_APPEARANCE } from '@shared/appearance'
import type { AppSettings } from './store/settings'
import type { ProviderConfig, ProviderConfigInput } from '@shared/schema/provider'
import { extraMcpServerSchema, type ExtraMcpServer } from '@shared/schema/mcpServer'
import {
  ATTACHMENT_MAX_BYTES,
  createStagingStore,
  stagingDirFor
} from './attachments'
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
const TIMELINE_ID = 8
const OTHER_TIMELINE_ID = 9

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
  ui: {
    theme: 'dark',
    locale: 'de',
    appearance: DEFAULT_APPEARANCE,
    cliSurface: 'session',
    reflowNeighbors: true,
    snapToZones: true,
    startMinimized: false,
    cliWindowMode: 'per-agent',
    onboardingDismissed: false
  },
  remote: { enabled: false, bindAddress: '', port: 9482 },
  yoloMaster: true,
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
        statusText: 'plant',
        taskText: 'Fix the parser'
      }
    ],
    // S4: present here so the preload parity check below covers the board row
    // as well — a field only main knows about is a field the panel cannot draw.
    tasks: [
      {
        taskId: 'task-1',
        subject: 'Build the parser',
        status: 'in_progress',
        ownerAgentId: `${id}-orch`,
        blockedBy: [],
        ready: false
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
    started: Array<{ profileId: string; goal?: string; attachmentIds?: string[] }>
    worktrees: Record<string, string>
    goalsAssigned: Array<{ workspaceId: string; goal: string }>
    resumed: string[]
    sentToOrchestrator: Array<{ workspaceId: string; text: string }>
    stopped: string[]
    succeeded: string[]
    focused: string[]
    focusedWorkspaces: string[]
    closedAgents: string[]
    answered: Array<{ workspaceId: string; agentId: string; questionId: string; text: string }>
    userMessages: Array<{ workspaceId: string; text: string; targetAgentId?: string }>
    promoted: Array<{ workspaceId: string; agentId: string }>
    runFolders: string[]
    openedTimelines: string[]
    removedWorktrees: Array<{ profileId: string; path: string }>
    staleWorktrees: { path: string; branch?: string }[]
    appliedZones: Array<{ profileId: string; zones: unknown }>
    change?: () => void
    timelineEvents: unknown[]
    timelineListener?: (event: unknown) => void
  }
  timelineSent: Array<{ workspaceId: string; event: unknown }>
  timelineClosed: number[]
  health: ReturnType<typeof vi.fn>
  /** WP-7: the login probe behind `providers:authStatus`. */
  auth: ReturnType<typeof vi.fn>
  discover: ReturnType<typeof vi.fn>
  pick: ReturnType<typeof vi.fn>
  pickSave: ReturnType<typeof vi.fn>
  pickOpen: ReturnType<typeof vi.fn>
  written: Array<{ path: string; text: string }>
  files: Map<string, string>
  opened: (string | undefined)[]
  /** WP-7: the orchestrator hint each editor-open carried, in the same order. */
  openedHints: (string | undefined)[]
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
  const openedHints: (string | undefined)[] = []
  const closed: number[] = []
  const providerEditorsOpened: (string | undefined)[] = []
  const providerEditorsClosed: number[] = []
  const health = vi.fn(
    async (configs: readonly ProviderConfig[]): Promise<ProviderHealth[]> =>
      configs.map((config) => ({ id: config.id, available: true, checkedAt: 1 }))
  )
  const auth = vi.fn(
    async (configs: readonly ProviderConfig[]) =>
      configs.map((config) => ({
        id: config.id,
        state: 'logged-in' as const,
        loginCommand: `${config.command} login`,
        checkedAt: 1
      }))
  )
  const discover = vi.fn(async (config: ProviderConfig) => ({
    models: [`${config.id}-model`],
    source: 'live' as const,
    refreshedAt: 1
  }))
  const pick = vi.fn(async () => 'C:/git/picked')
  const pickSave = vi.fn(async () => 'C:/tmp/vertragus-vertragus.json')
  const pickOpen = vi.fn(async () => 'C:/tmp/import.json')
  const written: Array<{ path: string; text: string }> = []
  const files = new Map<string, string>()
  const result = {
    ipc,
    store,
    broadcasts,
    health,
    auth,
    discover,
    pick,
    pickSave,
    pickOpen,
    written,
    files,
    opened,
    openedHints,
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
    timelineSent: [] as Array<{ workspaceId: string; event: unknown }>,
    timelineClosed: [] as number[],
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
    started: [] as Array<{ profileId: string; goal?: string; attachmentIds?: string[] }>,
    worktrees: {} as Record<string, string>,
    goalsAssigned: [] as Array<{ workspaceId: string; goal: string }>,
    resumed: [] as string[],
    sentToOrchestrator: [] as Array<{ workspaceId: string; text: string }>,
    stopped: [] as string[],
    succeeded: [] as string[],
    focused: [] as string[],
    focusedWorkspaces: [] as string[],
    closedAgents: [] as string[],
    answered: [] as Array<{ workspaceId: string; agentId: string; questionId: string; text: string }>,
    userMessages: [] as Array<{ workspaceId: string; text: string; targetAgentId?: string }>,
    promoted: [] as Array<{ workspaceId: string; agentId: string }>,
    runFolders: [] as string[],
    openedTimelines: [] as string[],
    removedWorktrees: [] as Array<{ profileId: string; path: string }>,
    staleWorktrees: [
      { path: '/repo/.vertragus/worktrees/old-1', branch: 'vertragus/paradiso/caronte' }
    ] as { path: string; branch?: string }[],
    appliedZones: [] as Array<{ profileId: string; zones: unknown }>,
    applyProfileZones(profileId: string, zones: unknown) {
      this.appliedZones.push({ profileId, zones })
    },
    list: () => state.workspaces,
    start(profileId: string, goal?: string, attachmentIds?: readonly string[]) {
      this.started.push({
        profileId,
        ...(goal !== undefined ? { goal } : {}),
        ...(attachmentIds?.length ? { attachmentIds: [...attachmentIds] } : {})
      })
    },
    worktreePathOf(workspaceId: string, agentId?: string) {
      return this.worktrees[`${workspaceId}:${agentId ?? ''}`]
    },
    async assignGoal(workspaceId: string, goal: string) {
      this.goalsAssigned.push({ workspaceId, goal })
    },
    resume(profileId: string) {
      this.resumed.push(profileId)
    },
    sendToOrchestrator(workspaceId: string, text: string) {
      this.sentToOrchestrator.push({ workspaceId, text })
    },
    stop(workspaceId: string) {
      this.stopped.push(workspaceId)
    },
    succeedOrchestrator(workspaceId: string) {
      this.succeeded.push(workspaceId)
    },
    async answerQuestion(workspaceId: string, agentId: string, questionId: string, text: string) {
      this.answered.push({ workspaceId, agentId, questionId, text })
    },
    postUserMessage(workspaceId: string, text: string, targetAgentId?: string) {
      this.userMessages.push({ workspaceId, text, ...(targetAgentId ? { targetAgentId } : {}) })
    },
    async promoteAgentBranch(workspaceId: string, agentId: string) {
      this.promoted.push({ workspaceId, agentId })
    },
    async openRunFolder(workspaceId: string) {
      if (workspaceId === 'gone') throw new Error(`run folder rejected — unknown workspace ${workspaceId}`)
      this.runFolders.push(workspaceId)
    },
    openTimeline(workspaceId: string) {
      this.openedTimelines.push(workspaceId)
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
    },
    timelineEvents: [] as unknown[],
    timelineListener: undefined as ((event: unknown) => void) | undefined,
    async readTimelineEvents() {
      return this.timelineEvents
    },
    onTimelineEvent(_workspaceId: string, listener: (event: unknown) => void) {
      this.timelineListener = listener
      return () => {
        this.timelineListener = undefined
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
    checkProviderAuth: auth,
    pickDirectory: pick,
    pickSaveFile: pickSave,
    pickOpenFile: pickOpen,
    writeTextFile: (path, text) => {
      written.push({ path, text })
      files.set(path, text)
    },
    readTextFile: (path) => {
      const text = files.get(path)
      if (text === undefined) throw new Error(`ENOENT: ${path}`)
      return text
    },
    fileSize: (path) => {
      const text = files.get(path)
      if (text === undefined) throw new Error(`ENOENT: ${path}`)
      return Buffer.byteLength(text, 'utf8')
    },
    openProfileEditor: (profileId, providerId) => {
      opened.push(profileId)
      openedHints.push(providerId)
    },
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
      { id: 11, label: 'Main', width: 1920, height: 1040, x: 0, y: 0, primary: true },
      { id: 22, label: 'Side', width: 1600, height: 860, x: 1920, y: 100, primary: false }
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
    timelineSender: (id) =>
      id === TIMELINE_ID ? 'w1' : id === OTHER_TIMELINE_ID ? 'w2' : null,
    sendTimelineEvent: (workspaceId, event) => {
      result.timelineSent.push({ workspaceId, event })
      return true
    },
    closeTimeline: (webContentsId) => {
      result.timelineClosed.push(webContentsId)
    },
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

describe('profile export / import', () => {
  it('writes a packed bundle without zones and with the custom roles in use', async () => {
    const qa: RoleTemplate = { id: 'qa', name: 'QA', prompt: 'Find bugs.', builtin: false }
    h.store.saveRoleTemplate(qa)
    h.store.saveProfile({
      ...profile('p1', 'Vertragus'),
      rolePrompts: [{ roleId: 'qa', prompt: 'Speak German.' }],
      slots: [{ id: 'p1-slot', roleId: 'qa', providerId: 'claude' }],
      zones: { zones: [{ roleId: 'qa', displayId: 1, rect: { x: 0, y: 0, w: 0.5, h: 0.5 } }] }
    })

    const result = (await h.ipc.invoke(APP_CHANNELS.profilesExport, EDITOR_ID, {
      profileId: 'p1'
    })) as { path: string }
    expect(result.path).toBe('C:/tmp/vertragus-vertragus.json')
    expect(h.pickSave).toHaveBeenCalledWith(
      EDITOR_ID,
      expect.objectContaining({ defaultPath: 'vertragus-vertragus.json' })
    )
    const written = JSON.parse(h.written[0]!.text) as {
      profile: Profile
      roleTemplates: RoleTemplate[]
    }
    expect(written.profile.zones).toBeUndefined()
    expect(written.profile.rolePrompts).toEqual([{ roleId: 'qa', prompt: 'Speak German.' }])
    expect(written.roleTemplates).toEqual([qa])
  })

  it('returns null when the save dialog is cancelled and writes nothing', async () => {
    h.pickSave.mockResolvedValueOnce(null)
    await expect(h.ipc.invoke(APP_CHANNELS.profilesExport, PANEL_ID, { profileId: 'p1' })).resolves.toBe(
      null
    )
    expect(h.written).toEqual([])
  })

  it('refuses a missing id in English (renderer bug) and an unknown profile in the UI locale', async () => {
    await expect(h.ipc.invoke(APP_CHANNELS.profilesExport, PANEL_ID, {})).rejects.toThrow(
      /profiles:export rejected — missing profile id/
    )
    await expect(
      h.ipc.invoke(APP_CHANNELS.profilesExport, PANEL_ID, { profileId: 'ghost' })
    ).rejects.toThrow(/Unbekanntes Profil ghost/)
  })

  it('imports a bundle as a new profile, adding its custom role', async () => {
    const qa: RoleTemplate = { id: 'qa', name: 'QA', prompt: 'Find bugs.', builtin: false }
    const source = profileSchema.parse({
      ...profile('foreign', 'UWE'),
      slots: [{ id: 's1', roleId: 'qa', providerId: 'claude' }],
      rolePrompts: [{ roleId: 'orchestrator', prompt: 'Be brief.' }],
      zones: { zones: [{ roleId: 'qa', displayId: 3, rect: { x: 0, y: 0, w: 0.4, h: 0.4 } }] }
    })
    h.files.set('C:/tmp/import.json', serializeProfileBundle(packProfileBundle(source, [qa])))

    const profiles = (await h.ipc.invoke(APP_CHANNELS.profilesImport, PANEL_ID)) as Profile[]
    const imported = profiles.find((entry) => entry.name === 'UWE')
    expect(imported).toBeDefined()
    expect(imported!.id).not.toBe('foreign')
    expect(imported!.zones).toBeUndefined()
    expect(imported!.rolePrompts).toEqual([{ roleId: 'orchestrator', prompt: 'Be brief.' }])
    expect(imported!.slots[0]!.roleId).toBe('qa')
    expect(h.store.getRoleTemplates()).toEqual([qa])
    expect(h.broadcasts.at(-1)?.channel).toBe(APP_CHANNELS.eventProfiles)
  })

  it('returns null when the open dialog is cancelled', async () => {
    h.pickOpen.mockResolvedValueOnce(null)
    await expect(h.ipc.invoke(APP_CHANNELS.profilesImport, EDITOR_ID)).resolves.toBe(null)
    expect(h.store.getProfiles()).toHaveLength(2)
  })

  it('rejects a file that is not a profile', async () => {
    h.files.set('C:/tmp/import.json', '{"hello":true}')
    await expect(h.ipc.invoke(APP_CHANNELS.profilesImport, PANEL_ID)).rejects.toThrow(
      /kein Vertragus-Profil/
    )
  })

  it('refuses a file over the size cap before parsing it', async () => {
    const live = harness({ fileSize: () => 2_000_000 })
    live.files.set('C:/tmp/import.json', '{}')
    await expect(live.ipc.invoke(APP_CHANNELS.profilesImport, PANEL_ID)).rejects.toThrow(/zu groß/)
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

  it('re-probes on an explicit refresh and leaves the cache warm for the picker', async () => {
    // WP-7: the first-run card's ⟳ is the one affordance step 1 has, and its
    // own copy tells the user to press it after installing a CLI. Served from
    // the cache it would be a no-op for up to 30 s — a hit does not even
    // refresh its timestamp, so pressing again would change nothing either.
    await h.ipc.invoke(APP_CHANNELS.providersList, PANEL_ID)
    expect(h.health).toHaveBeenCalledTimes(1)

    await h.ipc.invoke(APP_CHANNELS.providersList, PANEL_ID, { refresh: true })
    expect(h.health).toHaveBeenCalledTimes(2)

    // The refresh overwrote the cache rather than dropping it: the picker's
    // frequent reads keep their TTL.
    await h.ipc.invoke(APP_CHANNELS.providersList, PANEL_ID)
    await h.ipc.invoke(APP_CHANNELS.providersList, EDITOR_ID, { refresh: false })
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

describe('provider login status (WP-7)', () => {
  it('answers the panel with one entry per effective provider', async () => {
    const statuses = (await h.ipc.invoke(APP_CHANNELS.providersAuthStatus, PANEL_ID)) as {
      id: string
      state: string
      loginCommand?: string
    }[]

    expect(statuses.map((entry) => entry.id)).toEqual(['claude', 'codex'])
    expect(statuses[0]).toMatchObject({ state: 'logged-in', loginCommand: 'claude login' })
    expect(h.auth.mock.calls[0]![0]).toHaveLength(2)
  })

  it('probes again on every call — "I just logged in" must not wait out a TTL', async () => {
    await h.ipc.invoke(APP_CHANNELS.providersAuthStatus, PANEL_ID)
    await h.ipc.invoke(APP_CHANNELS.providersAuthStatus, PANEL_ID)
    expect(h.auth).toHaveBeenCalledTimes(2)
  })

  it('includes a provider that was just created', async () => {
    h.ipc.invoke(APP_CHANNELS.providersSave, PANEL_ID, {
      id: 'my-cli',
      label: 'Mein CLI',
      command: 'mycli'
    })
    const statuses = (await h.ipc.invoke(APP_CHANNELS.providersAuthStatus, PANEL_ID)) as {
      id: string
    }[]
    expect(statuses.map((entry) => entry.id)).toEqual(['claude', 'codex', 'my-cli'])
  })

  it('is closed to a CLI window and to a zone overlay', () => {
    for (const sender of [CLI_ID, OVERLAY_A_ID]) {
      expect(() => h.ipc.invoke(APP_CHANNELS.providersAuthStatus, sender)).toThrow(
        /not a panel or editor/
      )
    }
    expect(h.auth).not.toHaveBeenCalled()
  })
})

describe('reading providers from the panel (WP-7)', () => {
  it('lets the panel read the list its first-run card draws', async () => {
    const entries = (await h.ipc.invoke(APP_CHANNELS.providersList, PANEL_ID)) as {
      config: ProviderConfig
      health?: ProviderHealth
    }[]
    expect(entries.map((entry) => entry.config.id)).toEqual(['claude', 'codex'])
  })

  it('still refuses every sender it refused before', () => {
    // The card is a read; widening the guard would be the regression. These are
    // the two window kinds that have their own bridge object and are NOT app
    // windows — a CLI window above all.
    for (const sender of [CLI_ID, OVERLAY_A_ID, OVERLAY_B_ID, 999]) {
      expect(() => h.ipc.invoke(APP_CHANNELS.providersList, sender)).toThrow(
        /not a panel or editor/
      )
    }
    expect(h.health).not.toHaveBeenCalled()
  })

  it('keeps the write channels closed to everything but panel and editors', () => {
    for (const channel of [APP_CHANNELS.providersSave, APP_CHANNELS.providersDelete]) {
      expect(() => h.ipc.invoke(channel, CLI_ID, { id: 'claude' })).toThrow(
        /not a panel or editor/
      )
    }
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

  it('forwards attachmentIds on start and never treats them as bytes', async () => {
    await h.ipc.invoke(APP_CHANNELS.workspacesStart, PANEL_ID, {
      profileId: 'p1',
      goal: 'see .vertragus/attachments/screenshot-aa.png',
      attachmentIds: ['id1', 'id2']
    })
    expect(h.directory.started).toEqual([
      {
        profileId: 'p1',
        goal: 'see .vertragus/attachments/screenshot-aa.png',
        attachmentIds: ['id1', 'id2']
      }
    ])
  })
})

describe('attachments:save', () => {
  const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
  let userData: string
  let worktree: string

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'vertragus-ipc-ud-'))
    worktree = mkdtempSync(join(tmpdir(), 'vertragus-ipc-wt-'))
  })
  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
    rmSync(worktree, { recursive: true, force: true })
  })

  function attachHarness() {
    const live = harness({
      stagingStore: createStagingStore({ dir: stagingDirFor(userData) }),
      readClipboardImage: () => ({ isEmpty: () => false, toPNG: () => PNG })
    })
    live.directory.worktrees['w1:'] = worktree
    live.directory.worktrees['w1:agent-w'] = worktree
    return live
  }

  it('stages a clipboard image for a profile without touching repoPath', async () => {
    const live = attachHarness()
    const result = (await live.ipc.invoke(APP_CHANNELS.attachmentsSave, PANEL_ID, {
      profileId: 'p1',
      source: 'clipboard'
    })) as { relativePath: string; stagingId: string }
    expect(result.relativePath).toMatch(/^\.vertragus\/attachments\/screenshot-[a-z0-9]+\.png$/)
    expect(result.stagingId).toBeTruthy()
    expect(existsSync(join(userData, 'attachment-staging', result.stagingId, 'payload'))).toBe(true)
    expect(existsSync(join('C:/git/demo', '.vertragus'))).toBe(false)
    expect(existsSync(join('C:/git/demo', ...result.relativePath.split('/')))).toBe(false)
  })

  it('writes a live workspace image into the agent worktree', async () => {
    const live = attachHarness()
    const result = (await live.ipc.invoke(APP_CHANNELS.attachmentsSave, PANEL_ID, {
      workspaceId: 'w1',
      source: { bytes: PNG, mime: 'image/png' }
    })) as { relativePath: string }
    expect(result.relativePath).toMatch(/^\.vertragus\/attachments\//)
    expect(existsSync(join(worktree, ...result.relativePath.split('/')))).toBe(true)
    expect(readFileSync(join(worktree, '.vertragus', '.gitignore'), 'utf8')).toBe('*\n')
  })

  it('empty clipboard is a no-op', async () => {
    const live = harness({
      stagingStore: createStagingStore({ dir: stagingDirFor(userData) }),
      readClipboardImage: () => ({ isEmpty: () => true, toPNG: () => PNG })
    })
    expect(
      await live.ipc.invoke(APP_CHANNELS.attachmentsSave, PANEL_ID, {
        profileId: 'p1',
        source: 'clipboard'
      })
    ).toBeNull()
  })

  it('rejects a missing target and an unknown workspace', async () => {
    const live = attachHarness()
    await expect(
      Promise.resolve(live.ipc.invoke(APP_CHANNELS.attachmentsSave, PANEL_ID, { source: 'clipboard' }))
    ).rejects.toThrow(/missing target/)
    await expect(
      Promise.resolve(
        live.ipc.invoke(APP_CHANNELS.attachmentsSave, PANEL_ID, {
          workspaceId: 'ghost',
          source: 'clipboard'
        })
      )
    ).rejects.toThrow(/unknown workspace/)
  })

  it('saves from an absolute path into a selected worker worktree', async () => {
    const live = attachHarness()
    const file = join(worktree, 'drop.jpg')
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])
    writeFileSync(file, jpeg)
    const result = (await live.ipc.invoke(APP_CHANNELS.attachmentsSave, PANEL_ID, {
      workspaceId: 'w1',
      agentId: 'agent-w',
      source: { absPath: file }
    })) as { relativePath: string }
    expect(result.relativePath).toMatch(/\.jpg$/)
    expect(existsSync(join(worktree, ...result.relativePath.split('/')))).toBe(true)
  })

  it('rejects oversized and non-image payloads before any write', async () => {
    const live = attachHarness()
    await expect(
      Promise.resolve(
        live.ipc.invoke(APP_CHANNELS.attachmentsSave, PANEL_ID, {
          profileId: 'p1',
          source: { bytes: new Uint8Array(ATTACHMENT_MAX_BYTES + 1), mime: 'image/png' }
        })
      )
    ).rejects.toThrow(/8 MiB/)
    await expect(
      Promise.resolve(
        live.ipc.invoke(APP_CHANNELS.attachmentsSave, PANEL_ID, {
          workspaceId: 'w1',
          source: { bytes: Uint8Array.from(Buffer.from('not-an-image!!!!')), mime: 'text/plain' }
        })
      )
    ).rejects.toThrow(/Bild/)
    expect(existsSync(join('C:/git/demo', '.vertragus'))).toBe(false)
    expect(existsSync(join(worktree, '.vertragus'))).toBe(false)
  })

  it('is panel-only and keeps bytes off workspaces:goal', async () => {
    const live = attachHarness()
    expect(() =>
      live.ipc.invoke(APP_CHANNELS.attachmentsSave, CLI_ID, { profileId: 'p1', source: 'clipboard' })
    ).toThrow(/not the panel window/)
    await live.ipc.invoke(APP_CHANNELS.workspacesGoal, PANEL_ID, {
      workspaceId: 'w1',
      goal: '.vertragus/attachments/screenshot-aa.png'
    })
    expect(live.directory.goalsAssigned[0]).toEqual({
      workspaceId: 'w1',
      goal: '.vertragus/attachments/screenshot-aa.png'
    })
  })
})

describe('workspaces (goal refill and after)', () => {
  it('H2 refill: hands a running workspace its goal and refuses a blank one', async () => {
    await h.ipc.invoke(APP_CHANNELS.workspacesGoal, PANEL_ID, {
      workspaceId: 'w1',
      goal: '  Fix the login bug  '
    })
    expect(h.directory.goalsAssigned).toEqual([{ workspaceId: 'w1', goal: 'Fix the login bug' }])
    expect(h.broadcasts.at(-1)?.channel).toBe(APP_CHANNELS.eventWorkspaces)

    await expect(
      Promise.resolve(h.ipc.invoke(APP_CHANNELS.workspacesGoal, PANEL_ID, { goal: 'Goal.' }))
    ).rejects.toThrow(/missing workspace id/)
    // Unlike the start goal, a blank one here is an error, not a bare start.
    await expect(
      Promise.resolve(
        h.ipc.invoke(APP_CHANNELS.workspacesGoal, PANEL_ID, { workspaceId: 'w1', goal: '   ' })
      )
    ).rejects.toThrow(/missing goal text/)
    expect(h.directory.goalsAssigned).toHaveLength(1)
  })

  it('resumes the last run over the directory (E3) — panel only, id required', async () => {
    await h.ipc.invoke(APP_CHANNELS.workspacesResume, PANEL_ID, { profileId: 'p1' })
    expect(h.directory.resumed).toEqual(['p1'])
    await expect(
      Promise.resolve(h.ipc.invoke(APP_CHANNELS.workspacesResume, PANEL_ID, {}))
    ).rejects.toThrow(/missing profile id/)
    expect(() =>
      h.ipc.invoke(APP_CHANNELS.workspacesResume, CLI_ID, { profileId: 'p1' })
    ).toThrow(/not the panel/)
  })

  it('replaces an orchestrator over the directory (C6/S3) — panel only, id required', async () => {
    await h.ipc.invoke(APP_CHANNELS.workspacesSucceedOrchestrator, PANEL_ID, { workspaceId: 'w1' })
    expect(h.directory.succeeded).toEqual(['w1'])
    // The card's badge and the replace button both derive from the list.
    expect(h.broadcasts.map((entry) => entry.channel)).toEqual([APP_CHANNELS.eventWorkspaces])
    await expect(
      Promise.resolve(h.ipc.invoke(APP_CHANNELS.workspacesSucceedOrchestrator, PANEL_ID, {}))
    ).rejects.toThrow(/missing workspace id/)
    expect(() =>
      h.ipc.invoke(APP_CHANNELS.workspacesSucceedOrchestrator, CLI_ID, { workspaceId: 'w1' })
    ).toThrow(/not the panel/)
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

    await h.ipc.invoke(APP_CHANNELS.workspacesUserMessage, PANEL_ID, {
      workspaceId: 'w1',
      text: 'Run the login flow.',
      targetAgentId: '  a1  '
    })
    expect(h.directory.userMessages.at(-1)).toEqual({
      workspaceId: 'w1',
      text: 'Run the login flow.',
      targetAgentId: 'a1'
    })

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

  it('reveals a run folder — panel only, id required, disk failure stays loud', async () => {
    await h.ipc.invoke(APP_CHANNELS.workspacesOpenRunFolder, PANEL_ID, { workspaceId: 'w1' })
    // The single-id shorthand every other workspace channel accepts.
    await h.ipc.invoke(APP_CHANNELS.workspacesOpenRunFolder, PANEL_ID, 'w2')
    expect(h.directory.runFolders).toEqual(['w1', 'w2'])

    await expect(
      Promise.resolve(h.ipc.invoke(APP_CHANNELS.workspacesOpenRunFolder, PANEL_ID, {}))
    ).rejects.toThrow(/missing workspace id/)
    await expect(
      Promise.resolve(
        h.ipc.invoke(APP_CHANNELS.workspacesOpenRunFolder, PANEL_ID, { workspaceId: 'gone' })
      )
    ).rejects.toThrow(/unknown workspace gone/)

    // Desktop-only by construction: only the panel window may ask, and no
    // gateway verb mirrors it (see main/remote/gateway.test.ts).
    for (const sender of [CLI_ID, EDITOR_ID, SETTINGS_ID, PROVIDER_EDITOR_ID]) {
      expect(() =>
        h.ipc.invoke(APP_CHANNELS.workspacesOpenRunFolder, sender, { workspaceId: 'w1' })
      ).toThrow(/not the panel/)
    }
    expect(h.directory.runFolders).toEqual(['w1', 'w2'])
  })

  it('opens the overview sheet — panel only, id required', () => {
    h.ipc.invoke(APP_CHANNELS.workspacesOpenTimeline, PANEL_ID, { workspaceId: 'w1' })
    h.ipc.invoke(APP_CHANNELS.workspacesOpenTimeline, PANEL_ID, 'w2')
    expect(h.directory.openedTimelines).toEqual(['w1', 'w2'])

    expect(() => h.ipc.invoke(APP_CHANNELS.workspacesOpenTimeline, PANEL_ID, {})).toThrow(
      /missing workspace id/
    )

    for (const sender of [CLI_ID, EDITOR_ID, SETTINGS_ID, PROVIDER_EDITOR_ID, TIMELINE_ID]) {
      expect(() =>
        h.ipc.invoke(APP_CHANNELS.workspacesOpenTimeline, sender, { workspaceId: 'w1' })
      ).toThrow(/not the panel/)
    }
    expect(h.directory.openedTimelines).toEqual(['w1', 'w2'])
  })

  it('sends a follow-up to the running orchestrator', async () => {
    await h.ipc.invoke(APP_CHANNELS.workspacesSendToOrchestrator, PANEL_ID, {
      workspaceId: 'w1',
      text: '  follow up  '
    })
    expect(h.directory.sentToOrchestrator).toEqual([{ workspaceId: 'w1', text: 'follow up' }])
  })

  it('rejects sendToOrchestrator without a workspace id or non-empty text', () => {
    expect(() =>
      h.ipc.invoke(APP_CHANNELS.workspacesSendToOrchestrator, PANEL_ID, { text: 'hi' })
    ).toThrow(/missing workspace id/)
    expect(() =>
      h.ipc.invoke(APP_CHANNELS.workspacesSendToOrchestrator, PANEL_ID, { workspaceId: 'w1' })
    ).toThrow(/missing text/)
    expect(() =>
      h.ipc.invoke(APP_CHANNELS.workspacesSendToOrchestrator, PANEL_ID, {
        workspaceId: 'w1',
        text: '   '
      })
    ).toThrow(/missing text/)
    expect(h.directory.sentToOrchestrator).toEqual([])
  })

  it('rejects a CLI sender on sendToOrchestrator', () => {
    expect(() =>
      h.ipc.invoke(APP_CHANNELS.workspacesSendToOrchestrator, CLI_ID, {
        workspaceId: 'w1',
        text: 'hi'
      })
    ).toThrow(/not the panel/)
    expect(h.directory.sentToOrchestrator).toEqual([])
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
        assignGoal: async () => refuse(),
        resume: refuse,
        stop() {},
        sendToOrchestrator: refuse,
        succeedOrchestrator: refuse,
        answerQuestion: async () => refuse(),
        postUserMessage: refuse,
        promoteAgentBranch: async () => refuse(),
        openRunFolder: async () => refuse(),
        focusAgent() {},
        closeAgentWindow() {},
        focusWorkspace() {},
        openTimeline() {},
        listStaleWorktrees: async () => refuse(),
        removeWorktree: async () => refuse(),
        worktreePathOf: () => undefined
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

describe('runs archive IPC', () => {
  it('lists and gets runs for the panel only', async () => {
    const { listRuns, readRun } = await import('@main/workspace/listRuns')
    vi.mocked(listRuns).mockResolvedValue([
      { workspaceId: 'ws-1', status: 'stopped', endReason: 'user_stop' }
    ])
    vi.mocked(readRun).mockResolvedValue({
      workspaceId: 'ws-1',
      events: []
    })

    const listed = await h.ipc.invoke(APP_CHANNELS.runsList, PANEL_ID, { profileId: 'p1' })
    expect(listed).toEqual([{ workspaceId: 'ws-1', status: 'stopped', endReason: 'user_stop' }])
    expect(listRuns).toHaveBeenCalledWith('C:/git/demo', 'p1')

    const view = await h.ipc.invoke(APP_CHANNELS.runsGet, PANEL_ID, {
      profileId: 'p1',
      workspaceId: 'ws-1'
    })
    expect(view).toMatchObject({ workspaceId: 'ws-1' })

    expect(() => h.ipc.invoke(APP_CHANNELS.runsList, CLI_ID, { profileId: 'p1' })).toThrow(
      /not the panel/
    )
    expect(() => h.ipc.invoke(APP_CHANNELS.runsGet, CLI_ID, { profileId: 'p1', workspaceId: 'ws-1' })).toThrow(
      /not the panel/
    )
    await expect(Promise.resolve(h.ipc.invoke(APP_CHANNELS.runsList, PANEL_ID, {}))).rejects.toThrow(
      /missing profile id/
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
      appearance: DEFAULT_APPEARANCE,
      cliSurface: 'session',
      reflowNeighbors: true,
      snapToZones: true,
      startMinimized: false,
      cliWindowMode: 'per-agent',
      voiceEnabled: false,
      voiceWakePhrase: 'Hey Vertragus',
      voiceVoiceId: 'eve',
      voiceProvider: 'xai',
      voiceApiKeySet: false,
      voiceOpenaiApiKeySet: false,
      voiceInputDeviceId: '',
      voiceOutputDeviceId: '',
      onboardingDismissed: false,
      mcpServers: []
    })
    // Never the app's own bookkeeping — model memory, panel bounds and the
    // raw voice API keys have no form and must not leak to a renderer.
    expect(h.ipc.invoke(APP_CHANNELS.settingsGet, PANEL_ID)).not.toHaveProperty('modelMemory')
    expect(h.ipc.invoke(APP_CHANNELS.settingsGet, PANEL_ID)).not.toHaveProperty('apiKey')
    expect(h.ipc.invoke(APP_CHANNELS.settingsGet, PANEL_ID)).not.toHaveProperty('voiceApiKey')
    expect(h.ipc.invoke(APP_CHANNELS.settingsGet, PANEL_ID)).not.toHaveProperty('openaiApiKey')
  })

  it('never puts stored xAI or OpenAI keys on settings:get, only the *ApiKeySet flags', () => {
    h.store.settings.voice.apiKey = 'xai-secret'
    h.store.settings.voice.openaiApiKey = 'sk-secret'
    const got = h.ipc.invoke(APP_CHANNELS.settingsGet, PANEL_ID) as PanelSettings
    expect(got.voiceApiKeySet).toBe(true)
    expect(got.voiceOpenaiApiKeySet).toBe(true)
    expect(got).not.toHaveProperty('apiKey')
    expect(got).not.toHaveProperty('openaiApiKey')
    expect(JSON.stringify(got)).not.toContain('xai-secret')
    expect(JSON.stringify(got)).not.toContain('sk-secret')
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

  it('carries the first-run card orchestrator hint through (WP-7)', () => {
    h.ipc.invoke(APP_CHANNELS.profileEditorOpen, PANEL_ID, { providerId: 'codex' })
    // Blank is absent, not a provider id: a hint nobody sent must not become
    // an empty orchestrator on the new profile.
    h.ipc.invoke(APP_CHANNELS.profileEditorOpen, PANEL_ID, { providerId: '' })
    h.ipc.invoke(APP_CHANNELS.profileEditorOpen, PANEL_ID, 'p1')
    expect(h.opened).toEqual([undefined, undefined, 'p1'])
    expect(h.openedHints).toEqual(['codex', undefined, undefined])
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
      'cliSurface',
      'reflowNeighbors',
      'snapToZones',
      'startMinimized',
      'cliWindowMode',
      'voice',
      'agentPolicy',
      'onboardingDismissed',
      'mcpServers'
    ])
  })

  it('round-trips extra MCP servers and rejects a reserved id', async () => {
    const servers = [
      {
        id: 'github',
        label: 'GitHub',
        transport: 'stdio' as const,
        command: 'npx',
        args: [] as string[],
        enabled: true
      }
    ]
    const next = (await h.ipc.invoke(APP_CHANNELS.settingsSet, SETTINGS_ID, {
      key: 'mcpServers',
      value: servers
    })) as PanelSettings
    expect(next.mcpServers).toEqual([
      {
        id: 'github',
        label: 'GitHub',
        enabled: true,
        transport: 'stdio',
        command: 'npx',
        envKeys: [],
        headerKeys: [],
        envSet: {},
        headersSet: {}
      }
    ])
    expect(h.store.settings.mcpServers).toEqual(servers)
    expect(h.broadcasts.some((entry) => entry.channel === APP_CHANNELS.eventSettings)).toBe(true)

    await expect(
      h.ipc.invoke(APP_CHANNELS.settingsSet, SETTINGS_ID, {
        key: 'mcpServers',
        value: [{ id: 'vertragus', label: 'Nope', transport: 'stdio', command: 'npx' }]
      })
    ).rejects.toThrow(/reserved/)

    await expect(
      h.ipc.invoke(APP_CHANNELS.settingsSet, SETTINGS_ID, {
        key: 'mcpServers',
        value: [{ id: 'VERTRAGUS', label: 'Nope', transport: 'http', url: 'http://127.0.0.1/mcp' }]
      })
    ).rejects.toThrow(/reserved/)

    for (const sender of [CLI_ID, EDITOR_ID]) {
      expect(() =>
        h.ipc.invoke(APP_CHANNELS.settingsSet, sender, { key: 'mcpServers', value: [] })
      ).toThrow(/not the panel or the settings window/)
    }
  })

  it('strips MCP env/header values from PanelSettings and ev:settings', async () => {
    h.store.settings.mcpServers = [
      {
        id: 'github',
        label: 'GitHub',
        enabled: true,
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: { GITHUB_TOKEN: 'secret' }
      },
      {
        id: 'linear',
        label: 'Linear',
        enabled: true,
        transport: 'http',
        url: 'https://mcp.linear.app/mcp',
        headers: { Authorization: 'Bearer x' }
      }
    ]
    const panel = toPanelSettings(h.store.settings)
    expect(panel.mcpServers).toEqual([
      {
        id: 'github',
        label: 'GitHub',
        enabled: true,
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        envKeys: ['GITHUB_TOKEN'],
        headerKeys: [],
        envSet: { GITHUB_TOKEN: true },
        headersSet: {}
      },
      {
        id: 'linear',
        label: 'Linear',
        enabled: true,
        transport: 'http',
        url: 'https://mcp.linear.app/mcp',
        envKeys: [],
        headerKeys: ['Authorization'],
        envSet: {},
        headersSet: { Authorization: true }
      }
    ])
    expect(JSON.stringify(panel)).not.toContain('secret')
    expect(JSON.stringify(panel)).not.toContain('Bearer x')

    const next = (await h.ipc.invoke(APP_CHANNELS.settingsSet, SETTINGS_ID, {
      key: 'mcpServers',
      value: [
        {
          id: 'github',
          label: 'GitHub',
          enabled: true,
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: { GITHUB_TOKEN: '' }
        },
        {
          id: 'linear',
          label: 'Linear',
          enabled: true,
          transport: 'http',
          url: 'https://mcp.linear.app/mcp',
          headers: { Authorization: '' }
        }
      ]
    })) as PanelSettings

    expect(h.store.settings.mcpServers[0]).toMatchObject({ env: { GITHUB_TOKEN: 'secret' } })
    expect(h.store.settings.mcpServers[1]).toMatchObject({ headers: { Authorization: 'Bearer x' } })
    expect(next.mcpServers[0]!.envSet.GITHUB_TOKEN).toBe(true)
    expect(next.mcpServers[0]!.envKeys).toContain('GITHUB_TOKEN')
    expect(next.mcpServers[1]!.headersSet.Authorization).toBe(true)
    expect(JSON.stringify(next)).not.toContain('secret')
    expect(JSON.stringify(next)).not.toContain('Bearer x')

    const eventPayload = h.broadcasts
      .filter((entry) => entry.channel === APP_CHANNELS.eventSettings)
      .at(-1)?.payload as PanelSettings
    expect(JSON.stringify(eventPayload)).not.toContain('secret')
    expect(JSON.stringify(eventPayload)).not.toContain('Bearer x')
    expect(eventPayload.mcpServers[0]!.envSet.GITHUB_TOKEN).toBe(true)
  })

  it('deletes an env key omitted from the patch and keeps an empty-string key', async () => {
    h.store.settings.mcpServers = [
      {
        id: 'github',
        label: 'GitHub',
        enabled: true,
        transport: 'stdio',
        command: 'npx',
        args: [],
        env: { GITHUB_TOKEN: 'secret', OTHER: 'keep-me' }
      }
    ]
    await h.ipc.invoke(APP_CHANNELS.settingsSet, SETTINGS_ID, {
      key: 'mcpServers',
      value: [
        {
          id: 'github',
          label: 'GitHub',
          enabled: true,
          transport: 'stdio',
          command: 'npx',
          env: { OTHER: '' }
        }
      ]
    })
    expect(h.store.settings.mcpServers[0]).toMatchObject({ env: { OTHER: 'keep-me' } })
    expect(
      h.store.settings.mcpServers[0]!.transport === 'stdio' && h.store.settings.mcpServers[0]!.env
    ).not.toHaveProperty('GITHUB_TOKEN')
  })

  it('keeps GITHUB_TOKEN when the patch renames the server id', async () => {
    h.store.settings.mcpServers = [
      {
        id: 'github',
        label: 'GitHub',
        enabled: true,
        transport: 'stdio',
        command: 'npx',
        args: [],
        env: { GITHUB_TOKEN: 'secret' }
      }
    ]
    const next = (await h.ipc.invoke(APP_CHANNELS.settingsSet, SETTINGS_ID, {
      key: 'mcpServers',
      value: [
        {
          id: 'gh',
          label: 'GitHub',
          enabled: true,
          transport: 'stdio',
          command: 'npx',
          env: { GITHUB_TOKEN: '' }
        }
      ]
    })) as PanelSettings

    expect(h.store.settings.mcpServers).toHaveLength(1)
    expect(h.store.settings.mcpServers[0]).toMatchObject({
      id: 'gh',
      transport: 'stdio',
      env: { GITHUB_TOKEN: 'secret' }
    })
    expect(next.mcpServers[0]!.id).toBe('gh')
    expect(next.mcpServers[0]!.envSet.GITHUB_TOKEN).toBe(true)
    expect(JSON.stringify(next)).not.toContain('secret')
  })

  it('keeps the value when the patch renames an env key', async () => {
    h.store.settings.mcpServers = [
      {
        id: 'github',
        label: 'GitHub',
        enabled: true,
        transport: 'stdio',
        command: 'npx',
        args: [],
        env: { GITHUB_TOKEN: 'secret' }
      }
    ]
    const next = (await h.ipc.invoke(APP_CHANNELS.settingsSet, SETTINGS_ID, {
      key: 'mcpServers',
      value: [
        {
          id: 'github',
          label: 'GitHub',
          enabled: true,
          transport: 'stdio',
          command: 'npx',
          env: { GH_TOKEN: '' }
        }
      ]
    })) as PanelSettings

    expect(h.store.settings.mcpServers[0]).toMatchObject({ env: { GH_TOKEN: 'secret' } })
    expect(
      h.store.settings.mcpServers[0]!.transport === 'stdio' && h.store.settings.mcpServers[0]!.env
    ).not.toHaveProperty('GITHUB_TOKEN')
    expect(next.mcpServers[0]!.envKeys).toEqual(['GH_TOKEN'])
    expect(next.mcpServers[0]!.envSet.GH_TOKEN).toBe(true)
    expect(JSON.stringify(next)).not.toContain('secret')
  })

  it('does not copy one leftover secret onto two new ids of the same transport', () => {
    const current: ExtraMcpServer[] = [
      extraMcpServerSchema.parse({
        id: 'github',
        label: 'GitHub',
        transport: 'stdio',
        command: 'npx',
        env: { GITHUB_TOKEN: 'secret' }
      })
    ]
    const merged = mergeMcpServersPatch(current, [
      {
        id: 'alpha',
        label: 'Alpha',
        enabled: true,
        transport: 'stdio',
        command: 'npx',
        env: { GITHUB_TOKEN: '' }
      },
      {
        id: 'beta',
        label: 'Beta',
        enabled: true,
        transport: 'stdio',
        command: 'npx',
        env: { GITHUB_TOKEN: '' }
      }
    ])
    expect(merged).toHaveLength(2)
    expect(merged[0]).not.toHaveProperty('env')
    expect(merged[1]).not.toHaveProperty('env')
    expect(JSON.stringify(merged)).not.toContain('secret')
  })

  it('accepts a partial voice write and never puts the raw api keys on PanelSettings', async () => {
    h.store.settings.voice.apiKey = 'xai-secret'
    h.store.settings.voice.openaiApiKey = 'sk-secret'
    const next = (await h.ipc.invoke(APP_CHANNELS.settingsSet, SETTINGS_ID, {
      key: 'voice',
      value: {
        enabled: true,
        wakePhrase: 'Hey Grok',
        provider: 'openai',
        inputDeviceId: 'mic-1',
        outputDeviceId: 'spk-1'
      }
    })) as PanelSettings

    expect(h.store.settings.voice).toMatchObject({
      enabled: true,
      wakePhrase: 'Hey Grok',
      apiKey: 'xai-secret',
      openaiApiKey: 'sk-secret',
      provider: 'openai',
      voiceId: 'eve',
      inputDeviceId: 'mic-1',
      outputDeviceId: 'spk-1'
    })
    expect(next.voiceEnabled).toBe(true)
    expect(next.voiceWakePhrase).toBe('Hey Grok')
    expect(next.voiceVoiceId).toBe('eve')
    expect(next.voiceProvider).toBe('openai')
    expect(next.voiceApiKeySet).toBe(true)
    expect(next.voiceOpenaiApiKeySet).toBe(true)
    expect(next.voiceInputDeviceId).toBe('mic-1')
    expect(next.voiceOutputDeviceId).toBe('spk-1')
    expect(next).not.toHaveProperty('apiKey')
    expect(next).not.toHaveProperty('openaiApiKey')
    expect(JSON.stringify(next)).not.toContain('xai-secret')
    expect(JSON.stringify(next)).not.toContain('sk-secret')

    const pushed = h.broadcasts.filter((entry) => entry.channel === APP_CHANNELS.eventSettings)
    const eventPayload = pushed.at(-1)?.payload as PanelSettings
    expect(eventPayload.voiceApiKeySet).toBe(true)
    expect(eventPayload.voiceOpenaiApiKeySet).toBe(true)
    expect(eventPayload).not.toHaveProperty('apiKey')
    expect(eventPayload).not.toHaveProperty('openaiApiKey')
    expect(JSON.stringify(eventPayload)).not.toContain('xai-secret')
    expect(JSON.stringify(eventPayload)).not.toContain('sk-secret')
  })

  it('keeps the other stored api key when a partial voice write sets only one', async () => {
    h.store.settings.voice.apiKey = 'xai-keep'
    h.store.settings.voice.openaiApiKey = 'sk-keep'
    const openaiOnly = (await h.ipc.invoke(APP_CHANNELS.settingsSet, SETTINGS_ID, {
      key: 'voice',
      value: { openaiApiKey: 'sk-new' }
    })) as PanelSettings

    expect(h.store.settings.voice.apiKey).toBe('xai-keep')
    expect(h.store.settings.voice.openaiApiKey).toBe('sk-new')
    expect(openaiOnly.voiceApiKeySet).toBe(true)
    expect(openaiOnly.voiceOpenaiApiKeySet).toBe(true)
    expect(JSON.stringify(openaiOnly)).not.toContain('xai-keep')
    expect(JSON.stringify(openaiOnly)).not.toContain('sk-new')

    const xaiOnly = (await h.ipc.invoke(APP_CHANNELS.settingsSet, SETTINGS_ID, {
      key: 'voice',
      value: { apiKey: 'xai-new' }
    })) as PanelSettings
    expect(h.store.settings.voice.apiKey).toBe('xai-new')
    expect(h.store.settings.voice.openaiApiKey).toBe('sk-new')
    expect(xaiOnly.voiceApiKeySet).toBe(true)
    expect(xaiOnly.voiceOpenaiApiKeySet).toBe(true)
    expect(JSON.stringify(xaiOnly)).not.toContain('xai-new')
    expect(JSON.stringify(xaiOnly)).not.toContain('sk-new')
  })

  it('leaves stored api keys unchanged when the write sends empty strings', async () => {
    h.store.settings.voice.apiKey = 'xai-keep-me'
    h.store.settings.voice.openaiApiKey = 'sk-keep-me'
    const next = (await h.ipc.invoke(APP_CHANNELS.settingsSet, SETTINGS_ID, {
      key: 'voice',
      value: { apiKey: '', openaiApiKey: '' }
    })) as PanelSettings

    expect(h.store.settings.voice.apiKey).toBe('xai-keep-me')
    expect(h.store.settings.voice.openaiApiKey).toBe('sk-keep-me')
    expect(next.voiceApiKeySet).toBe(true)
    expect(next.voiceOpenaiApiKeySet).toBe(true)
    expect(JSON.stringify(next)).not.toContain('xai-keep-me')
    expect(JSON.stringify(next)).not.toContain('sk-keep-me')
  })

  it('replaces stored keys when the write sends non-empty strings', async () => {
    h.store.settings.voice.apiKey = 'xai-old'
    h.store.settings.voice.openaiApiKey = 'sk-old'
    const next = (await h.ipc.invoke(APP_CHANNELS.settingsSet, SETTINGS_ID, {
      key: 'voice',
      value: { apiKey: 'xai-new', openaiApiKey: 'sk-new' }
    })) as PanelSettings

    expect(h.store.settings.voice.apiKey).toBe('xai-new')
    expect(h.store.settings.voice.openaiApiKey).toBe('sk-new')
    expect(next.voiceApiKeySet).toBe(true)
    expect(next.voiceOpenaiApiKeySet).toBe(true)
    expect(JSON.stringify(next)).not.toContain('xai-new')
    expect(JSON.stringify(next)).not.toContain('sk-new')
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
      appearance: DEFAULT_APPEARANCE,
      cliSurface: 'session',
      reflowNeighbors: true,
      snapToZones: true,
      startMinimized: false,
      cliWindowMode: 'per-agent',
      onboardingDismissed: false
    })
  })

  it('patches reflowNeighbors into ui and rejects a non-boolean', async () => {
    const off = (await h.ipc.invoke(APP_CHANNELS.settingsSet, SETTINGS_ID, {
      key: 'reflowNeighbors',
      value: false
    })) as PanelSettings
    expect(off.reflowNeighbors).toBe(false)
    expect(h.store.settings.ui.reflowNeighbors).toBe(false)
    expect(h.store.settings.ui.theme).toBe('dark')

    const on = (await h.ipc.invoke(APP_CHANNELS.settingsSet, SETTINGS_ID, {
      key: 'reflowNeighbors',
      value: true
    })) as PanelSettings
    expect(on.reflowNeighbors).toBe(true)

    await expect(
      h.ipc.invoke(APP_CHANNELS.settingsSet, SETTINGS_ID, { key: 'reflowNeighbors', value: 'ja' })
    ).rejects.toThrow(/expects a boolean/)
    expect(h.store.settings.ui.reflowNeighbors).toBe(true)
  })

  it('patches cliSurface into ui and rejects junk', async () => {
    const raw = (await h.ipc.invoke(APP_CHANNELS.settingsSet, SETTINGS_ID, {
      key: 'cliSurface',
      value: 'raw'
    })) as PanelSettings
    expect(raw.cliSurface).toBe('raw')
    expect(h.store.settings.ui.cliSurface).toBe('raw')
    expect(h.store.settings.ui.theme).toBe('dark')

    const session = (await h.ipc.invoke(APP_CHANNELS.settingsSet, SETTINGS_ID, {
      key: 'cliSurface',
      value: 'session'
    })) as PanelSettings
    expect(session.cliSurface).toBe('session')

    await expect(
      h.ipc.invoke(APP_CHANNELS.settingsSet, SETTINGS_ID, { key: 'cliSurface', value: 'native' })
    ).rejects.toThrow(/expects session or raw/)
    expect(h.store.settings.ui.cliSurface).toBe('session')
  })

  it('patches snapToZones into ui and rejects a non-boolean', async () => {
    h.broadcasts.length = 0
    const off = (await h.ipc.invoke(APP_CHANNELS.settingsSet, SETTINGS_ID, {
      key: 'snapToZones',
      value: false
    })) as PanelSettings
    expect(off.snapToZones).toBe(false)
    expect(h.store.settings.ui.snapToZones).toBe(false)
    expect(h.store.settings.ui.reflowNeighbors).toBe(true)
    expect(h.store.settings.ui.theme).toBe('dark')
    expect(
      (h.broadcasts.find((entry) => entry.channel === APP_CHANNELS.eventSettings)
        ?.payload as PanelSettings).snapToZones
    ).toBe(false)
    expect(off).not.toHaveProperty('apiKey')

    const on = (await h.ipc.invoke(APP_CHANNELS.settingsSet, SETTINGS_ID, {
      key: 'snapToZones',
      value: true
    })) as PanelSettings
    expect(on.snapToZones).toBe(true)

    await expect(
      h.ipc.invoke(APP_CHANNELS.settingsSet, SETTINGS_ID, { key: 'snapToZones', value: 'ja' })
    ).rejects.toThrow(/expects a boolean/)
    expect(h.store.settings.ui.snapToZones).toBe(true)
  })

  it('patches startMinimized into ui and rejects a non-boolean', async () => {
    const on = (await h.ipc.invoke(APP_CHANNELS.settingsSet, SETTINGS_ID, {
      key: 'startMinimized',
      value: true
    })) as PanelSettings
    expect(on.startMinimized).toBe(true)
    expect(h.store.settings.ui.startMinimized).toBe(true)
    expect(h.store.settings.ui.theme).toBe('dark')

    const off = (await h.ipc.invoke(APP_CHANNELS.settingsSet, SETTINGS_ID, {
      key: 'startMinimized',
      value: false
    })) as PanelSettings
    expect(off.startMinimized).toBe(false)

    await expect(
      h.ipc.invoke(APP_CHANNELS.settingsSet, SETTINGS_ID, { key: 'startMinimized', value: 'ja' })
    ).rejects.toThrow(/expects a boolean/)
    expect(h.store.settings.ui.startMinimized).toBe(false)
  })

  it('patches cliWindowMode into ui and rejects an invented mode', async () => {
    const tabs = (await h.ipc.invoke(APP_CHANNELS.settingsSet, SETTINGS_ID, {
      key: 'cliWindowMode',
      value: 'tabs'
    })) as PanelSettings
    expect(tabs.cliWindowMode).toBe('tabs')
    expect(h.store.settings.ui.cliWindowMode).toBe('tabs')
    expect(h.store.settings.ui.theme).toBe('dark')

    const perAgent = (await h.ipc.invoke(APP_CHANNELS.settingsSet, SETTINGS_ID, {
      key: 'cliWindowMode',
      value: 'per-agent'
    })) as PanelSettings
    expect(perAgent.cliWindowMode).toBe('per-agent')

    await expect(
      h.ipc.invoke(APP_CHANNELS.settingsSet, SETTINGS_ID, { key: 'cliWindowMode', value: 'windows' })
    ).rejects.toThrow(/expects per-agent or tabs/)
    expect(h.store.settings.ui.cliWindowMode).toBe('per-agent')
  })

  it('lets the panel close the first-run card for good (WP-7)', async () => {
    const next = (await h.ipc.invoke(APP_CHANNELS.settingsSet, PANEL_ID, {
      key: 'onboardingDismissed',
      value: true
    })) as PanelSettings

    expect(next.onboardingDismissed).toBe(true)
    // Patched into `ui`, not written over it: theme and locale survive.
    expect(h.store.settings.ui).toMatchObject({ theme: 'dark', locale: 'de' })
    // Every window learns about it in the same tick, like any other setting.
    expect(h.broadcasts.map((entry) => entry.channel)).toContain(APP_CHANNELS.eventSettings)
  })

  it('refuses a dismiss payload that is not a boolean', async () => {
    await expect(
      h.ipc.invoke(APP_CHANNELS.settingsSet, SETTINGS_ID, {
        key: 'onboardingDismissed',
        value: 'ja'
      })
    ).rejects.toThrow(/expects a boolean/)
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

describe('voice IPC', () => {
  function voicePort(): {
    status: ReturnType<typeof vi.fn>
    setEnabled: ReturnType<typeof vi.fn>
    pushPcm: ReturnType<typeof vi.fn>
  } {
    return {
      status: vi.fn(() => ({ phase: 'listening', enabled: true })),
      setEnabled: vi.fn(async () => undefined),
      pushPcm: vi.fn()
    }
  }

  it('reports idle from the store when no runtime is wired', () => {
    expect(h.ipc.invoke(APP_CHANNELS.voiceStatus, PANEL_ID)).toEqual({
      phase: 'idle',
      enabled: false
    })
  })

  it('persists setEnabled and starts the optional runtime', async () => {
    const voice = voicePort()
    const live = harness({ voice })
    const status = await live.ipc.invoke(APP_CHANNELS.voiceSetEnabled, PANEL_ID, { enabled: true })
    expect(live.store.settings.voice.enabled).toBe(true)
    expect(voice.setEnabled).toHaveBeenCalledWith(true)
    expect(status).toEqual({ phase: 'listening', enabled: true })
    const pushed = live.broadcasts.filter((entry) => entry.channel === APP_CHANNELS.eventSettings)
    expect((pushed.at(-1)?.payload as PanelSettings).voiceEnabled).toBe(true)
    expect(JSON.stringify(pushed.at(-1)?.payload)).not.toMatch(/apiKey/)
  })

  it('forwards panel PCM to the runtime and ignores a CLI sender', () => {
    const voice = voicePort()
    const live = harness({ voice })
    const pcm = new Int16Array([1, 2, 3, 4])
    live.ipc.send(APP_CHANNELS.voicePcm, PANEL_ID, pcm)
    expect(voice.pushPcm).toHaveBeenCalledTimes(1)
    expect(voice.pushPcm.mock.calls[0]![0]).toEqual(pcm)

    live.ipc.send(APP_CHANNELS.voicePcm, CLI_ID, new Int16Array([9]))
    expect(voice.pushPcm).toHaveBeenCalledTimes(1)
  })

  it('rejects voice invokes from a CLI window', () => {
    expect(() => h.ipc.invoke(APP_CHANNELS.voiceStatus, CLI_ID)).toThrow(/not the panel window/)
    expect(() =>
      h.ipc.invoke(APP_CHANNELS.voiceSetEnabled, CLI_ID, { enabled: true })
    ).toThrow(/not the panel window/)
    expect(h.store.settings.voice.enabled).toBe(false)
  })

  it('rejects a settings window on the panel-only voice channels', () => {
    expect(() => h.ipc.invoke(APP_CHANNELS.voiceStatus, SETTINGS_ID)).toThrow(/not the panel window/)
    expect(() =>
      h.ipc.invoke(APP_CHANNELS.voiceSetEnabled, SETTINGS_ID, { enabled: true })
    ).toThrow(/not the panel window/)
  })

  it('recreates the runtime after a voice or locale write while enabled', async () => {
    const voice = voicePort()
    const live = harness({ voice })
    live.store.settings.voice.enabled = true
    await live.ipc.invoke(APP_CHANNELS.settingsSet, SETTINGS_ID, {
      key: 'voice',
      value: { wakePhrase: 'Hey Grok' }
    })
    expect(voice.setEnabled).toHaveBeenCalledWith(true)

    await live.ipc.invoke(APP_CHANNELS.settingsSet, SETTINGS_ID, {
      key: 'locale',
      value: 'en'
    })
    expect(voice.setEnabled).toHaveBeenCalledTimes(2)
    expect(voice.setEnabled).toHaveBeenLastCalledWith(true)
  })
})

describe('sender authorization', () => {
  const panelOnly = [
    APP_CHANNELS.workspacesList,
    APP_CHANNELS.workspacesStart,
    APP_CHANNELS.attachmentsSave,
    APP_CHANNELS.workspacesSendToOrchestrator,
    APP_CHANNELS.workspacesGoal,
    APP_CHANNELS.workspacesStop,
    APP_CHANNELS.workspacesSucceedOrchestrator,
    APP_CHANNELS.workspacesFocusAgent,
    APP_CHANNELS.workspacesFocus,
    APP_CHANNELS.workspacesCloseAgent,
    APP_CHANNELS.settingsYolo,
    APP_CHANNELS.windowsHideAll,
    APP_CHANNELS.windowsMinimizePanel,
    APP_CHANNELS.appQuit,
    APP_CHANNELS.voiceStatus,
    APP_CHANNELS.voiceSetEnabled
  ]
  const appWindows = [
    APP_CHANNELS.profilesList,
    APP_CHANNELS.profilesSave,
    APP_CHANNELS.profilesDelete,
    APP_CHANNELS.profilesExport,
    APP_CHANNELS.profilesImport,
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
    expect(payload.reflowNeighbors).toBe(true)
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
    expect(saved.zones?.targetWorkArea).toEqual({ x: 0, y: 0, width: 1920, height: 1040 })
    expect(h.directory.appliedZones).toEqual([{ profileId: 'p1', zones: saved.zones }])
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

  it('does not write reflowNeighbors from a draft', () => {
    h.broadcasts.length = 0
    h.ipc.send(APP_CHANNELS.zonesDraft, OVERLAY_A_ID, {
      zones: [{ roleId: 'worker', rect: rel(0, 0, 0.5, 1) }],
      reflowNeighbors: false
    })
    expect(h.store.settings.ui.reflowNeighbors).toBe(true)
    expect(h.store.getProfiles().find((entry) => entry.id === 'p1')!.zones).toBeUndefined()
    expect(h.broadcasts.filter((entry) => entry.channel === APP_CHANNELS.eventSettings)).toEqual([])
  })

  it('persists reflowNeighbors from a save payload', () => {
    h.ipc.invoke(APP_CHANNELS.zonesSave, OVERLAY_A_ID, {
      profileId: 'p1',
      zones: [],
      reflowNeighbors: false
    })
    expect(h.store.settings.ui.reflowNeighbors).toBe(false)
  })

  it('ignores a non-boolean reflowNeighbors on a draft', () => {
    expect(() =>
      h.ipc.send(APP_CHANNELS.zonesDraft, OVERLAY_A_ID, {
        zones: [{ roleId: 'worker', rect: rel(0, 0, 0.5, 1) }],
        reflowNeighbors: 'nope'
      })
    ).not.toThrow()
    expect(h.store.settings.ui.reflowNeighbors).toBe(true)
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
    expect(
      h.store.getProfiles().find((entry) => entry.id === 'p1')!.zones?.targetWorkArea
    ).toEqual({ x: 1920, y: 100, width: 1600, height: 860 })
    expect(h.directory.appliedZones).toEqual([
      {
        profileId: 'p1',
        zones: h.store.getProfiles().find((entry) => entry.id === 'p1')!.zones
      }
    ])
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
    expect(openProfileEditorWindow).toHaveBeenCalledWith('p1', undefined)
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
      assignGoal: vi.fn(async () => {}),
      resume: vi.fn(),
      stop: vi.fn(),
      sendToOrchestrator: vi.fn(),
      succeedOrchestrator: vi.fn(),
      answerQuestion: vi.fn(async () => {}),
      postUserMessage: vi.fn(),
      promoteAgentBranch: vi.fn(async () => {}),
      openRunFolder: vi.fn(async () => {}),
      openTimeline: vi.fn(),
      focusAgent: vi.fn(),
      closeAgentWindow: vi.fn(),
      focusWorkspace: vi.fn(),
      listStaleWorktrees: vi.fn(async () => []),
      removeWorktree: vi.fn(async () => []),
      worktreePathOf: vi.fn()
    }
    const second: WorkspaceDirectory = {
      list: () => [],
      start: vi.fn(),
      assignGoal: vi.fn(async () => {}),
      resume: vi.fn(),
      stop: vi.fn(),
      sendToOrchestrator: vi.fn(),
      succeedOrchestrator: vi.fn(),
      answerQuestion: vi.fn(async () => {}),
      postUserMessage: vi.fn(),
      promoteAgentBranch: vi.fn(async () => {}),
      openRunFolder: vi.fn(async () => {}),
      openTimeline: vi.fn(),
      focusAgent: vi.fn(),
      closeAgentWindow: vi.fn(),
      focusWorkspace: vi.fn(),
      listStaleWorktrees: vi.fn(async () => []),
      removeWorktree: vi.fn(async () => []),
      worktreePathOf: vi.fn()
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

/**
 * The panel is the only surface a boot failure can reach. `console.error` is
 * not one — nobody opens a devtools console to find out why Play did nothing.
 */
describe('stub workspace directory', () => {
  it('names the boot failure instead of blaming an unfinished feature', () => {
    const stub = createStubWorkspaceDirectory(() => 'en', 'listen EADDRINUSE :::9481')
    expect(() => stub.start('p1')).toThrow(
      'The workspace manager could not start — no agents can be launched: listen EADDRINUSE :::9481'
    )
    // Every workspace channel, not just Play: Resume is the likelier first click.
    expect(() => stub.resume('p1')).toThrow(/listen EADDRINUSE/)
    expect(() => stub.stop('w1')).toThrow(/listen EADDRINUSE/)
  })

  it('speaks the stored locale — the reason rides along in the CLI’s own words', () => {
    const stub = createStubWorkspaceDirectory(() => 'de', 'spawn claude ENOENT')
    expect(() => stub.start('p1')).toThrow(
      'Workspace-Manager konnte nicht starten — Agenten lassen sich nicht anlegen: spawn claude ENOENT'
    )
  })

  /** Without a recorded reason there is nothing honest to add. */
  it('falls back to the plain refusal when no boot error was recorded', () => {
    expect(() => createStubWorkspaceDirectory(() => 'en').start('p1')).toThrow(
      'The workspace manager is not wired up yet.'
    )
  })

  /** The refusals are the point; the read-only halves must stay usable. */
  it('still lists nothing and still focuses a CLI window', () => {
    const stub = createStubWorkspaceDirectory(() => 'en', 'boom')
    expect(stub.list()).toEqual([])
    expect(() => stub.focusWorkspace('w1')).not.toThrow()
    expect(() => stub.openTimeline('w1')).not.toThrow()
  })
})

describe('preload parity', () => {
  it('uses exactly the channel names main registers', () => {
    const source = readFileSync(join(__dirname, '../preload/index.ts'), 'utf8')
    // The remote-access channels are registered separately (main/remote/ipc.ts)
    // but still cross this bridge, so they count toward parity too.
    const expected = new Set([
      ...Object.values(APP_CHANNELS),
      ...Object.values(REMOTE_CHANNELS),
      ...Object.values(BROWSER_EXTENSION_CHANNELS)
    ])
    for (const channel of expected) {
      expect(source).toContain(`'${channel}'`)
    }
    const found = [
      ...source.matchAll(
        /'((?:profiles|roles|providers|models|workspaces|worktrees|retro|runs|settings|settingsWindow|updates|windows|app|dialog|profileEditor|providerEditor|zones|remote|voice|ev|attachments|timeline):[a-zA-Z]+)'/g
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

describe('timeline broadcast membership', () => {
  it('includes timeline windows in appWindows so they receive ev:workspaces', () => {
    const source = readFileSync(join(__dirname, 'appIpc.ts'), 'utf8')
    expect(source).toMatch(/listTimelineWindows\(\)\.map\(\(entry\) => entry\.window\)/)
    expect(source).toMatch(/eventTimeline: 'ev:timeline'/)
    expect(source).not.toMatch(/eventWorkspaces: 'ev:timeline'/)
  })
})

describe('capTimelineEvents', () => {
  it('keeps a suffix at the EventQueue ring size', () => {
    const events = Array.from({ length: TIMELINE_EVENTS_MAX + 5 }, (_, i) => i)
    expect(capTimelineEvents(events)).toEqual(
      Array.from({ length: TIMELINE_EVENTS_MAX }, (_, i) => i + 5)
    )
    expect(capTimelineEvents([1, 2, 3])).toEqual([1, 2, 3])
  })
})

describe('requirePanelOrOwnTimeline', () => {
  it('lets the bound timeline stop its own workspace and refuses another', async () => {
    await h.ipc.invoke(APP_CHANNELS.workspacesStop, TIMELINE_ID, { workspaceId: 'w1' })
    expect(h.directory.stopped).toEqual(['w1'])
    expect(() =>
      h.ipc.invoke(APP_CHANNELS.workspacesStop, TIMELINE_ID, { workspaceId: 'w2' })
    ).toThrow(/not bound to that workspace/)
    expect(h.directory.stopped).toEqual(['w1'])
  })

  it('never lets timeline-A focus an agent of workspace-B', () => {
    expect(() =>
      h.ipc.invoke(APP_CHANNELS.workspacesFocusAgent, OTHER_TIMELINE_ID, { agentId: 'w1-orch' })
    ).toThrow(/does not belong to this timeline/)
    expect(h.directory.focused).toEqual([])
    h.ipc.invoke(APP_CHANNELS.workspacesFocusAgent, TIMELINE_ID, { agentId: 'w1-orch' })
    expect(h.directory.focused).toEqual(['w1-orch'])
  })

  it('lets the bound timeline refill the goal, answer, promote and open the run folder', async () => {
    await h.ipc.invoke(APP_CHANNELS.workspacesGoal, TIMELINE_ID, {
      workspaceId: 'w1',
      goal: 'ship it'
    })
    await h.ipc.invoke(APP_CHANNELS.workspacesAnswerQuestion, TIMELINE_ID, {
      workspaceId: 'w1',
      agentId: 'w1-orch',
      questionId: 'q1',
      text: 'yes'
    })
    await h.ipc.invoke(APP_CHANNELS.workspacesPromoteAgent, TIMELINE_ID, {
      workspaceId: 'w1',
      agentId: 'w1-orch'
    })
    await h.ipc.invoke(APP_CHANNELS.workspacesOpenRunFolder, TIMELINE_ID, { workspaceId: 'w1' })
    expect(h.directory.goalsAssigned).toEqual([{ workspaceId: 'w1', goal: 'ship it' }])
    expect(h.directory.answered).toEqual([
      { workspaceId: 'w1', agentId: 'w1-orch', questionId: 'q1', text: 'yes' }
    ])
    expect(h.directory.promoted).toEqual([{ workspaceId: 'w1', agentId: 'w1-orch' }])
    expect(h.directory.runFolders).toEqual(['w1'])
  })

  it('still rejects a CLI window on those channels', () => {
    expect(() =>
      h.ipc.invoke(APP_CHANNELS.workspacesStop, CLI_ID, { workspaceId: 'w1' })
    ).toThrow(/not the panel window/)
  })

  it('lets a timeline list workspaces (it filters client-side)', () => {
    expect(h.ipc.invoke(APP_CHANNELS.workspacesList, TIMELINE_ID)).toHaveLength(1)
  })
})

describe('timeline:attach', () => {
  it('answers a host-read snapshot and pushes live events to that window only', async () => {
    const event = {
      type: 'agent_started' as const,
      seq: 1,
      ts: 1,
      agentId: 'a1',
      name: 'Virgilio',
      roleId: 'orchestrator'
    }
    h.directory.timelineEvents = [event]
    const snapshot = (await h.ipc.invoke(APP_CHANNELS.timelineAttach, TIMELINE_ID)) as {
      workspaceId: string
      events: unknown[]
    }
    expect(snapshot).toEqual({ workspaceId: 'w1', events: [event] })

    h.directory.timelineListener?.(event)
    expect(h.timelineSent).toEqual([{ workspaceId: 'w1', event }])
    expect(h.broadcasts.map((entry) => entry.channel)).not.toContain(APP_CHANNELS.eventTimeline)
  })

  it('refuses a foreign workspace id and a non-timeline sender', async () => {
    await expect(
      Promise.resolve(h.ipc.invoke(APP_CHANNELS.timelineAttach, TIMELINE_ID, { workspaceId: 'w2' }))
    ).rejects.toThrow(/own workspace/)
    expect(() => h.ipc.invoke(APP_CHANNELS.timelineAttach, PANEL_ID)).toThrow(
      /not a timeline window/
    )
    expect(() => h.ipc.invoke(APP_CHANNELS.timelineAttach, CLI_ID)).toThrow(
      /not a timeline window/
    )
  })

  it('caps the snapshot at the EventQueue ring size', async () => {
    h.directory.timelineEvents = Array.from({ length: TIMELINE_EVENTS_MAX + 3 }, (_, i) => ({
      type: 'agent_progress' as const,
      seq: i + 1,
      ts: i,
      agentId: 'a1',
      name: 'Virgilio',
      roleId: 'orchestrator',
      note: String(i)
    }))
    const snapshot = (await h.ipc.invoke(APP_CHANNELS.timelineAttach, TIMELINE_ID)) as {
      events: Array<{ seq: number }>
    }
    expect(snapshot.events).toHaveLength(TIMELINE_EVENTS_MAX)
    expect(snapshot.events[0]!.seq).toBe(4)
  })

  it('closes only the sender timeline', () => {
    h.ipc.send(APP_CHANNELS.timelineClose, TIMELINE_ID)
    h.ipc.send(APP_CHANNELS.timelineClose, PANEL_ID)
    expect(h.timelineClosed).toEqual([TIMELINE_ID])
  })
})

describe('agentCurrentTaskFields', () => {
  it('fills taskText and statusText from one current-task note', () => {
    expect(agentCurrentTaskFields('Fix the parser')).toEqual({
      taskText: 'Fix the parser',
      statusText: 'Fix the parser'
    })
    expect(agentCurrentTaskFields(undefined)).toEqual({})
    expect(agentCurrentTaskFields('   ')).toEqual({})
  })
})
