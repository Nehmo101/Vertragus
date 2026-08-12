import { contextBridge, ipcRenderer } from 'electron'
import type { Profile, RoleTemplate } from '@shared/schema/profile'
import type { ProviderConfig } from '@shared/schema/provider'
import type { Zone, ZoneLayout } from '@shared/schema/zones'
import type { Appearance } from '@shared/appearance'

/**
 * The renderer bridge. One API object per window type; a CLI window only ever
 * gets the terminal surface, and that surface carries no agentId for input,
 * resize or close — the main process derives the agent from the sender window,
 * so a renderer cannot address a foreign agent even if it tries.
 *
 * Channel names are duplicated from src/main/ipc.ts on purpose: preload is
 * bundled separately and must not import main code. ipc.test.ts asserts both
 * lists stay identical.
 */
const CHANNELS = {
  attach: 'terminal:attach',
  input: 'terminal:input',
  resize: 'terminal:resize',
  data: 'terminal:data',
  exit: 'terminal:exit',
  windowClose: 'window:close',
  windowMinimize: 'window:minimize'
} as const

export interface TerminalAgentMeta {
  agentId: string
  name: string
  role: string
  roleColor: string
  provider: string
  model: string
}

export interface TerminalAttachResult {
  snapshot: string
  cols: number
  rows: number
  meta: TerminalAgentMeta
  exit: { exitCode: number; signal?: number } | null
  /** UI language at attach time; CLI windows cannot query settings. */
  locale?: string
  /** Appearance at attach time; CLI windows cannot query settings. */
  theme?: 'dark' | 'light'
}

export interface TerminalDataEvent {
  agentId: string
  data: string
}

export interface TerminalExitEvent {
  agentId: string
  exitCode: number
  signal?: number
}

const terminal = {
  /** Replay the scrollback and learn who this window belongs to. */
  attach: (agentId: string): Promise<TerminalAttachResult> =>
    ipcRenderer.invoke(CHANNELS.attach, { agentId }),
  input: (data: string): void => {
    ipcRenderer.send(CHANNELS.input, data)
  },
  resize: (cols: number, rows: number): void => {
    ipcRenderer.send(CHANNELS.resize, { cols, rows })
  },
  onData: (listener: (event: TerminalDataEvent) => void): (() => void) => {
    const handler = (_event: unknown, payload: TerminalDataEvent): void => listener(payload)
    ipcRenderer.on(CHANNELS.data, handler)
    return () => {
      ipcRenderer.removeListener(CHANNELS.data, handler)
    }
  },
  onExit: (listener: (event: TerminalExitEvent) => void): (() => void) => {
    const handler = (_event: unknown, payload: TerminalExitEvent): void => listener(payload)
    ipcRenderer.on(CHANNELS.exit, handler)
    return () => {
      ipcRenderer.removeListener(CHANNELS.exit, handler)
    }
  },
  /** Close this window only — the agent keeps running. */
  closeWindow: (): void => {
    ipcRenderer.send(CHANNELS.windowClose)
  },
  /** Minimize this window — the agent keeps running and the window stays registered. */
  minimizeWindow: (): void => {
    ipcRenderer.send(CHANNELS.windowMinimize)
  }
}

/**
 * App surface — panel and profile editor. Same rule as above: the channel names
 * are duplicated from src/main/appIpc.ts because preload is bundled separately;
 * appIpc.test.ts asserts both lists stay identical.
 *
 * Authorization is not attempted here. Every channel below is checked in the
 * main process by WINDOW TYPE (panel / profile editor), so exposing the same
 * object in both windows is safe: a CLI window that somehow called these would
 * be rejected on the other side.
 */
const APP = {
  profilesList: 'profiles:list',
  profilesSave: 'profiles:save',
  profilesDelete: 'profiles:delete',
  rolesList: 'roles:list',
  rolesSave: 'roles:save',
  providersList: 'providers:list',
  providersSave: 'providers:save',
  providersDelete: 'providers:delete',
  modelsDiscover: 'models:discover',
  workspacesList: 'workspaces:list',
  workspacesStart: 'workspaces:start',
  workspacesStop: 'workspaces:stop',
  workspacesFocusAgent: 'workspaces:focusAgent',
  workspacesFocus: 'workspaces:focus',
  settingsGet: 'settings:get',
  settingsYolo: 'settings:yolo',
  settingsSet: 'settings:set',
  windowsHideAll: 'windows:hideAll',
  appQuit: 'app:quit',
  dialogPickDirectory: 'dialog:pickDirectory',
  profileEditorOpen: 'profileEditor:open',
  profileEditorClose: 'profileEditor:close',
  providerEditorOpen: 'providerEditor:open',
  providerEditorClose: 'providerEditor:close',
  settingsWindowOpen: 'settingsWindow:open',
  settingsWindowClose: 'settingsWindow:close',
  updatesGet: 'updates:get',
  updatesCheck: 'updates:check',
  updatesInstall: 'updates:install',
  zonesEdit: 'zones:edit',
  zonesLoad: 'zones:load',
  zonesDraft: 'zones:draft',
  zonesSave: 'zones:save',
  zonesCancel: 'zones:cancel',
  eventProfiles: 'ev:profiles',
  eventProviders: 'ev:providers',
  eventWorkspaces: 'ev:workspaces',
  eventUpdate: 'ev:update',
  eventSettings: 'ev:settings',
  settingsAppearance: 'settings:appearance',
  eventAppearance: 'ev:appearance'
} as const

/**
 * Main → panel push: is the OS cursor over the panel window?
 *
 * Not part of {@link APP}: nothing invokes it, it is emitted by
 * `main/windows/panelHover.ts` (which owns the name and asserts this literal
 * stays identical), and the panel's whole-surface drag region is the reason it
 * has to exist at all — CSS `:hover` cannot see through a drag region on
 * Windows.
 */
const PANEL_POINTER = 'panel:pointer'

/** Payload of the pointer push above. */
export interface PanelPointerEvent {
  inside: boolean
}

export type PanelAgentState = 'working' | 'waiting' | 'stopped'

export interface WorkspaceAgentSummary {
  agentId: string
  name: string
  roleId: string
  roleLabel?: string
  roleColor: string
  state: PanelAgentState
  statusText?: string
  pendingQuestion?: string
}

export interface WorkspaceSummary {
  workspaceId: string
  name: string
  profileId: string
  profileName?: string
  active: boolean
  /** Latest assignment the orchestrator handed out — the tooltip's task line. */
  taskText?: string
  agents: WorkspaceAgentSummary[]
}

/** Result of a provider version probe (see main/providers/health.ts). */
export interface ProviderHealth {
  id: string
  available: boolean
  version?: string
  detail?: string
  error?: string
  checkedAt: number
}

export interface ProviderListEntry {
  config: ProviderConfig
  health?: ProviderHealth
}

export interface ModelDiscoveryResult {
  models: string[]
  /**
   * `seed` = only the provider's rolling aliases, `mixed` = discovered ids plus
   * at least one of them. See `@main/providers/discovery`.
   */
  source: 'live' | 'memory' | 'seed' | 'mixed' | 'none'
  refreshedAt: number
  /** Why the live source stayed empty — shown in the model picker. */
  detail?: string
}

export interface PanelSettings {
  yoloMaster: boolean
  hideAllHotkey: string
  locale: 'de' | 'en'
  theme: 'dark' | 'light'
  /** Window opacity and glass transparency; see @shared/appearance. */
  appearance: Appearance
  autostart: boolean
  updateChannel: UpdateChannel
  /** False in a dev run — the login item would point at the Electron binary. */
  autostartSupported: boolean
  /** Present only when the global hide-all hotkey could not be registered. */
  hideAllHotkeyError?: string
}

export type UpdateChannel = 'main' | 'stable'

/** The keys the settings form may write; see WRITABLE_SETTINGS in main/appIpc. */
export type WritableSetting =
  | 'hideAllHotkey'
  | 'autostart'
  | 'updateChannel'
  | 'theme'
  | 'locale'
  | 'appearance'

export type UpdateStatus =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'error'

/** State of the self-updater (see main/updater.ts). */
export interface UpdateState {
  status: UpdateStatus
  currentVersion: string
  availableVersion?: string
  channel: UpdateChannel
  /** 0–100 while downloading. */
  progress?: number
  message?: string
}

/** One entry of the zone editor's role palette (see main/appIpc.ts). */
export interface ZoneEditorRole {
  roleId: string
  label: string
  color: string
}

/** What one zone overlay window needs to draw its display. */
export interface ZoneEditorPayload {
  profileId: string
  profileName: string
  displayId: number
  roles: ZoneEditorRole[]
  zones: Zone[]
  /** UI language — an overlay window may not call `settings:get` itself. */
  locale?: 'de' | 'en'
  /** Appearance — same constraint as locale. */
  theme?: 'dark' | 'light'
}

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: unknown, payload: T): void => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

const app = {
  listProfiles: (): Promise<Profile[]> => ipcRenderer.invoke(APP.profilesList),
  saveProfile: (profile: Profile): Promise<Profile[]> =>
    ipcRenderer.invoke(APP.profilesSave, profile),
  deleteProfile: (id: string): Promise<Profile[]> => ipcRenderer.invoke(APP.profilesDelete, { id }),
  listRoles: (): Promise<RoleTemplate[]> => ipcRenderer.invoke(APP.rolesList),
  saveRole: (template: RoleTemplate): Promise<RoleTemplate[]> =>
    ipcRenderer.invoke(APP.rolesSave, template),
  listProviders: (): Promise<ProviderListEntry[]> => ipcRenderer.invoke(APP.providersList),
  discoverModels: (providerId: string): Promise<ModelDiscoveryResult> =>
    ipcRenderer.invoke(APP.modelsDiscover, { providerId }),
  listWorkspaces: (): Promise<WorkspaceSummary[]> => ipcRenderer.invoke(APP.workspacesList),
  startWorkspace: (profileId: string): Promise<void> =>
    ipcRenderer.invoke(APP.workspacesStart, { profileId }),
  stopWorkspace: (workspaceId: string): Promise<void> =>
    ipcRenderer.invoke(APP.workspacesStop, { workspaceId }),
  focusAgent: (agentId: string): Promise<void> =>
    ipcRenderer.invoke(APP.workspacesFocusAgent, { agentId }),
  focusWorkspace: (workspaceId: string): Promise<void> =>
    ipcRenderer.invoke(APP.workspacesFocus, { workspaceId }),
  getSettings: (): Promise<PanelSettings> => ipcRenderer.invoke(APP.settingsGet),
  /**
   * How see-through the app is. Unlike `getSettings` this one answers in EVERY
   * window, CLI windows included — they have to paint their first frame at the
   * user's opacity, and they are not app windows on the main-process guard.
   */
  getAppearance: (): Promise<Appearance> => ipcRenderer.invoke(APP.settingsAppearance),
  setYoloMaster: (enabled: boolean): Promise<PanelSettings> =>
    ipcRenderer.invoke(APP.settingsYolo, { enabled }),
  /**
   * Write one setting. Main applies the side effect (hotkey, login item,
   * update channel) and answers with the whole, re-read settings object — the
   * form never keeps its own idea of what is stored.
   */
  setSetting: (key: WritableSetting, value: unknown): Promise<PanelSettings> =>
    ipcRenderer.invoke(APP.settingsSet, { key, value }),
  hideAllWindows: (): Promise<void> => ipcRenderer.invoke(APP.windowsHideAll),
  /**
   * Quit Vertragus. Resolves false when running agents made main ask and the
   * user cancelled; true means the shutdown is under way.
   */
  quitApp: (): Promise<boolean> => ipcRenderer.invoke(APP.appQuit),
  pickDirectory: (defaultPath?: string): Promise<string | null> =>
    ipcRenderer.invoke(APP.dialogPickDirectory, { defaultPath }),
  openProfileEditor: (profileId?: string): Promise<void> =>
    ipcRenderer.invoke(APP.profileEditorOpen, { profileId }),
  /**
   * Write a provider descriptor. Saving under a preset id EDITS that built-in;
   * the merged list that comes back is what every picker should show next.
   */
  saveProvider: (config: ProviderConfig): Promise<ProviderConfig[]> =>
    ipcRenderer.invoke(APP.providersSave, config),
  /**
   * Drop a stored provider. For a preset id this is "reset to preset" — the
   * built-in reappears — and for a custom one it is deletion.
   */
  deleteProvider: (id: string): Promise<ProviderConfig[]> =>
    ipcRenderer.invoke(APP.providersDelete, { id }),
  /** Open the provider editor; no id = a provider that does not exist yet. */
  openProviderEditor: (providerId?: string): Promise<void> =>
    ipcRenderer.invoke(APP.providerEditorOpen, { providerId }),
  /** The panel's gear. */
  openSettings: (): Promise<void> => ipcRenderer.invoke(APP.settingsWindowOpen),
  /** Close the settings window; only the settings window itself may call it. */
  closeSettings: (): void => {
    ipcRenderer.send(APP.settingsWindowClose)
  },
  getUpdateState: (): Promise<UpdateState> => ipcRenderer.invoke(APP.updatesGet),
  checkForUpdates: (): Promise<UpdateState> => ipcRenderer.invoke(APP.updatesCheck),
  /** Restart into the downloaded update — the panel badge's click target. */
  installUpdate: (): Promise<void> => ipcRenderer.invoke(APP.updatesInstall),
  /** Open the on-screen zone editor for a SAVED profile (one overlay/display). */
  editZones: (profileId: string): Promise<void> =>
    ipcRenderer.invoke(APP.zonesEdit, { profileId }),
  /** Close this editor window; the agent-free equivalent of terminal.closeWindow. */
  closeProfileEditor: (): void => {
    ipcRenderer.send(APP.profileEditorClose)
  },
  /** Close this provider editor window. */
  closeProviderEditor: (): void => {
    ipcRenderer.send(APP.providerEditorClose)
  },
  onProfiles: (listener: (profiles: Profile[]) => void): (() => void) =>
    subscribe(APP.eventProfiles, listener),
  /**
   * The effective provider list changed — someone saved or reset a descriptor.
   * The profile editor's picker listens so a provider created from its own
   * "+ Eigener Provider …" entry appears without reopening the window.
   */
  onProviders: (listener: (providers: ProviderConfig[]) => void): (() => void) =>
    subscribe(APP.eventProviders, listener),
  onWorkspaces: (listener: (workspaces: WorkspaceSummary[]) => void): (() => void) =>
    subscribe(APP.eventWorkspaces, listener),
  /** Self-update state — drives the panel's "Update bereit" badge. */
  onUpdate: (listener: (state: UpdateState) => void): (() => void) =>
    subscribe(APP.eventUpdate, listener),
  /**
   * App settings changed anywhere. The renderer's i18n and theme modules
   * subscribe so a language or appearance picked in the settings window reaches
   * the panel, editors, CLI chrome and zone overlays at once.
   */
  onSettings: (listener: (settings: PanelSettings) => void): (() => void) =>
    subscribe(APP.eventSettings, listener),
  /**
   * Appearance changed. Pushed to every window (see `ev:appearance`), so a
   * slider moved in the settings window redraws the panel and every open
   * terminal in the same tick.
   */
  onAppearance: (listener: (appearance: Appearance) => void): (() => void) =>
    subscribe(APP.eventAppearance, listener),
  /** Cursor enters/leaves the panel window — the panel's hover signal. */
  onPointer: (listener: (event: PanelPointerEvent) => void): (() => void) =>
    subscribe(PANEL_POINTER, listener)
}

/**
 * Zone overlay surface — exposed to every window, authorized in main by window
 * type: only a live overlay window may read or write a zone layout, so the
 * panel or a CLI window calling these is rejected on the other side.
 */
const zones = {
  /** Palette, profile name and the zones of THIS overlay's display. */
  load: (): Promise<ZoneEditorPayload> => ipcRenderer.invoke(APP.zonesLoad),
  /**
   * Push the current rectangles of this display without saving. Every overlay
   * does this while dragging, so whichever window hits "save" persists the
   * whole multi-monitor layout and not just its own screen.
   */
  draft: (list: readonly Zone[]): void => {
    ipcRenderer.send(APP.zonesDraft, { zones: list })
  },
  /** Persist the layout of every overlay and close the session. */
  save: (profileId: string, list: readonly Zone[]): Promise<ZoneLayout> =>
    ipcRenderer.invoke(APP.zonesSave, { profileId, zones: list }),
  /** Esc: close every overlay, save nothing. */
  cancel: (): void => {
    ipcRenderer.send(APP.zonesCancel)
  }
}

const api = {
  platform: process.platform,
  terminal,
  app,
  zones
}

export type VertragusApi = typeof api
export type VertragusAppApi = typeof app
export type VertragusZonesApi = typeof zones

contextBridge.exposeInMainWorld('vertragus', api)
