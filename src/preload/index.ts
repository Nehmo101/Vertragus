import { contextBridge, ipcRenderer } from 'electron'
import type { Profile, RoleTemplate } from '@shared/schema/profile'
import type { ProviderConfig } from '@shared/schema/provider'

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
  windowClose: 'window:close'
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
  modelsDiscover: 'models:discover',
  workspacesList: 'workspaces:list',
  workspacesStart: 'workspaces:start',
  workspacesStop: 'workspaces:stop',
  workspacesFocusAgent: 'workspaces:focusAgent',
  settingsGet: 'settings:get',
  settingsYolo: 'settings:yolo',
  windowsHideAll: 'windows:hideAll',
  dialogPickDirectory: 'dialog:pickDirectory',
  profileEditorOpen: 'profileEditor:open',
  profileEditorClose: 'profileEditor:close',
  eventProfiles: 'ev:profiles',
  eventWorkspaces: 'ev:workspaces'
} as const

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
  source: 'live' | 'memory' | 'none'
  refreshedAt: number
}

export interface PanelSettings {
  yoloMaster: boolean
  hideAllHotkey: string
  locale: 'de' | 'en'
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
  getSettings: (): Promise<PanelSettings> => ipcRenderer.invoke(APP.settingsGet),
  setYoloMaster: (enabled: boolean): Promise<PanelSettings> =>
    ipcRenderer.invoke(APP.settingsYolo, { enabled }),
  hideAllWindows: (): Promise<void> => ipcRenderer.invoke(APP.windowsHideAll),
  pickDirectory: (defaultPath?: string): Promise<string | null> =>
    ipcRenderer.invoke(APP.dialogPickDirectory, { defaultPath }),
  openProfileEditor: (profileId?: string): Promise<void> =>
    ipcRenderer.invoke(APP.profileEditorOpen, { profileId }),
  /** Close this editor window; the agent-free equivalent of terminal.closeWindow. */
  closeProfileEditor: (): void => {
    ipcRenderer.send(APP.profileEditorClose)
  },
  onProfiles: (listener: (profiles: Profile[]) => void): (() => void) =>
    subscribe(APP.eventProfiles, listener),
  onWorkspaces: (listener: (workspaces: WorkspaceSummary[]) => void): (() => void) =>
    subscribe(APP.eventWorkspaces, listener)
}

const api = {
  platform: process.platform,
  terminal,
  app
}

export type VertragusApi = typeof api
export type VertragusAppApi = typeof app

contextBridge.exposeInMainWorld('vertragus', api)
