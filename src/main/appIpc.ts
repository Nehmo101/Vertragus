/**
 * App IPC — the bridge for the panel and the profile editor.
 *
 * The terminal bridge in `./ipc.ts` is *per agent*: it derives the agent from
 * the sender window, so a renderer can never address a foreign PTY. This layer
 * is different in kind — it serves app-wide state (profiles, providers, models,
 * workspaces) — so authorization is by WINDOW TYPE instead: the panel may drive
 * workspaces and settings, the panel and the profile editor may read and write
 * profiles, and every other window (a CLI window, above all) is rejected
 * outright on every channel.
 *
 * The workspace half is deliberately programmed against {@link WorkspaceDirectory}
 * rather than against a concrete manager: the WorkspaceManager is built
 * separately, and until it is injected `registerAppIpc()` runs on a stub that
 * lists nothing and refuses to start anything *loudly* — a silent no-op would
 * look exactly like a broken Play button.
 *
 * Everything else follows `./ipc.ts`: `createAppIpc(host)` is the testable core,
 * `registerAppIpc()` is the production wiring, and the channel names are
 * duplicated in preload with a parity test that fails on drift.
 */
import { BrowserWindow, dialog, ipcMain } from 'electron'
import type { Profile } from '@shared/schema/profile'
import type { ProviderConfig } from '@shared/schema/provider'
import type { AppSettings, SettingsStore } from '@main/store/settings'
import { settings } from '@main/store/settings'
import { discoverModels, type ModelDiscoveryResult } from '@main/providers/discovery'
import { checkAllProviders, type ProviderHealth } from '@main/providers/health'
import { focusCliWindow } from '@main/windows/cliWindow'
import { getPanelWindow, isPanelWindowSender } from '@main/windows/panel'
import {
  armProfileEditorSmoke,
  closeProfileEditorWindow,
  isProfileEditorWindowSender,
  listProfileEditorWindows,
  openProfileEditorWindow
} from '@main/windows/profileEditor'
import type { MinimalIpcMain } from './ipc'

export const APP_CHANNELS = {
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

/** Health probes are cheap but not free; a re-opened editor reuses this. */
export const PROVIDER_HEALTH_TTL_MS = 30_000

// --- the workspace side, as an interface ---------------------------------

/** Lifecycle state of one agent as the panel paints it. */
export type PanelAgentState = 'working' | 'waiting' | 'stopped'

/** One agent row of a workspace card. */
export interface WorkspaceAgentSummary {
  agentId: string
  /** Commedia code-name; the panel resolves its lore blurb for the tooltip. */
  name: string
  roleId: string
  /** Human role label ("Orchestrator", "Worker"); the panel falls back to roleId. */
  roleLabel?: string
  roleColor: string
  state: PanelAgentState
  /** Short activity note ("plant", "T-142"). Absent = derived from `state`. */
  statusText?: string
  /** Set while the agent waits for an answer — drives the `?` badge. */
  pendingQuestion?: string
}

/** One workspace card. */
export interface WorkspaceSummary {
  workspaceId: string
  /** Commedia place-name with cycle suffix, e.g. "Paradiso II". */
  name: string
  profileId: string
  profileName?: string
  /** False once the orchestrator is gone — the card greys out but stays. */
  active: boolean
  agents: WorkspaceAgentSummary[]
}

/**
 * What this layer needs from the workspace world. The real implementation is
 * the WorkspaceManager; tests and the not-yet-wired app use the stub below.
 */
export interface WorkspaceDirectory {
  list(): WorkspaceSummary[]
  /**
   * Play: open a new workspace for this profile. The return value is ignored
   * (and typed loosely) so a manager whose `startWorkspace` resolves with its
   * own runtime object needs no adapter lambda here.
   */
  start(profileId: string): void | Promise<unknown>
  stop(workspaceId: string): void | Promise<unknown>
  /** Bring an agent's CLI window to the front. */
  focusAgent(agentId: string): void
  /** Optional push channel; without it the panel only refreshes on demand. */
  onChange?(listener: () => void): () => void
}

/**
 * The directory used until the WorkspaceManager is injected. `list` is empty
 * and `focusAgent` still works (the CLI window registry exists), but `start`
 * and `stop` REFUSE loudly: a Play button that quietly does nothing is the
 * worst possible placeholder.
 */
export function createStubWorkspaceDirectory(): WorkspaceDirectory {
  return {
    list: () => [],
    start() {
      throw new Error('Workspace-Manager ist noch nicht verdrahtet.')
    },
    stop() {
      throw new Error('Workspace-Manager ist noch nicht verdrahtet.')
    },
    focusAgent: (agentId) => focusCliWindow(agentId)
  }
}

// --- host ----------------------------------------------------------------

/** The slice of the settings store this layer uses. */
export type AppSettingsPort = Pick<
  SettingsStore,
  | 'getProfiles'
  | 'saveProfile'
  | 'deleteProfile'
  | 'effectiveProviders'
  | 'getRoleTemplates'
  | 'saveRoleTemplate'
  | 'getSettings'
  | 'setSetting'
>

export interface ProviderListEntry {
  config: ProviderConfig
  /** Undefined while the probe is still unknown (never on a fresh list call). */
  health?: ProviderHealth
}

/** The settings the panel actually shows; the rest stays in the main process. */
export interface PanelSettings {
  yoloMaster: boolean
  hideAllHotkey: string
  locale: AppSettings['ui']['locale']
}

export interface AppIpcHost {
  ipcMain: MinimalIpcMain
  store: AppSettingsPort
  directory: WorkspaceDirectory
  isPanelSender(webContentsId: number): boolean
  /** Editor key (profile id, or `new`) behind this webContents, or null. */
  profileEditorSender(webContentsId: number): string | null
  discoverModels(config: ProviderConfig): Promise<ModelDiscoveryResult>
  checkProviders(configs: readonly ProviderConfig[]): Promise<ProviderHealth[]>
  pickDirectory(webContentsId: number, defaultPath?: string): Promise<string | null>
  openProfileEditor(profileId?: string): void
  closeProfileEditor(webContentsId: number): void
  /** Push to every app window (panel + open editors). */
  broadcast(channel: string, payload: unknown): void
  /** Hide every CLI window. Wired in M4; until then a logged no-op. */
  hideAll(): void
  now?(): number
}

export interface AppIpc {
  /** Push the current workspace list to the panel (the manager calls this). */
  emitWorkspaces(): void
  /** Push the current profile list (after an out-of-band change). */
  emitProfiles(): void
  dispose(): void
}

type IpcEvent = { sender: { id: number } }
type IpcListener = (event: IpcEvent, ...args: never[]) => unknown

function toPanelSettings(value: AppSettings): PanelSettings {
  return {
    yoloMaster: value.yoloMaster,
    hideAllHotkey: value.hideAllHotkey,
    locale: value.ui.locale
  }
}

export function createAppIpc(host: AppIpcHost): AppIpc {
  const now = host.now ?? (() => Date.now())
  let healthCache: { at: number; health: ProviderHealth[] } | undefined
  let unsubscribeDirectory: (() => void) | undefined

  /** Panel-only: workspaces, settings, hide-all. */
  const requirePanel = (event: IpcEvent, channel: string): void => {
    if (!host.isPanelSender(event.sender.id)) {
      throw new Error(`${channel} rejected — sender is not the panel window`)
    }
  }

  /** Panel or profile editor: profiles, roles, providers, models, folder pick. */
  const requireAppWindow = (event: IpcEvent, channel: string): void => {
    if (host.isPanelSender(event.sender.id)) return
    if (host.profileEditorSender(event.sender.id) !== null) return
    throw new Error(`${channel} rejected — sender is not a panel or editor window`)
  }

  const handle = (
    channel: string,
    guard: (event: IpcEvent, channel: string) => void,
    listener: (event: IpcEvent, payload?: unknown) => unknown
  ): void => {
    host.ipcMain.handle(channel, ((event: IpcEvent, payload?: unknown) => {
      guard(event, channel)
      return listener(event, payload)
    }) as IpcListener)
  }

  const emitProfiles = (profiles: Profile[]): void => {
    host.broadcast(APP_CHANNELS.eventProfiles, profiles)
  }
  const emitWorkspaces = (): void => {
    host.broadcast(APP_CHANNELS.eventWorkspaces, host.directory.list())
  }

  // --- profiles ----------------------------------------------------------

  handle(APP_CHANNELS.profilesList, requireAppWindow, () => host.store.getProfiles())

  handle(APP_CHANNELS.profilesSave, requireAppWindow, (_event, payload) => {
    // The store parses strictly: a rejected save must reach the editor as an
    // error it can show inline, never as a silently dropped write.
    const profiles = host.store.saveProfile(payload)
    emitProfiles(profiles)
    return profiles
  })

  handle(APP_CHANNELS.profilesDelete, requireAppWindow, (_event, payload) => {
    const id = typeof payload === 'string' ? payload : (payload as { id?: string })?.id
    if (!id) throw new Error('profiles:delete rejected — missing profile id')
    const profiles = host.store.deleteProfile(id)
    emitProfiles(profiles)
    return profiles
  })

  // --- roles -------------------------------------------------------------

  handle(APP_CHANNELS.rolesList, requireAppWindow, () => host.store.getRoleTemplates())

  handle(APP_CHANNELS.rolesSave, requireAppWindow, (_event, payload) =>
    host.store.saveRoleTemplate(payload)
  )

  // --- providers & models ------------------------------------------------

  handle(APP_CHANNELS.providersList, requireAppWindow, async () => {
    const configs = host.store.effectiveProviders()
    const cached = healthCache && now() - healthCache.at <= PROVIDER_HEALTH_TTL_MS
    // Probes run in parallel inside checkProviders — one dead CLI must not
    // serialize the picker behind its timeout.
    const health = cached ? healthCache!.health : await host.checkProviders(configs)
    if (!cached) healthCache = { at: now(), health }
    const byId = new Map(health.map((entry) => [entry.id, entry]))
    return configs.map<ProviderListEntry>((config) => ({
      config,
      health: byId.get(config.id)
    }))
  })

  handle(APP_CHANNELS.modelsDiscover, requireAppWindow, async (_event, payload) => {
    const providerId =
      typeof payload === 'string' ? payload : (payload as { providerId?: string })?.providerId
    const config = host.store.effectiveProviders().find((entry) => entry.id === providerId)
    if (!config) throw new Error(`models:discover rejected — unknown provider ${providerId}`)
    return host.discoverModels(config)
  })

  // --- workspaces --------------------------------------------------------

  handle(APP_CHANNELS.workspacesList, requirePanel, () => host.directory.list())

  handle(APP_CHANNELS.workspacesStart, requirePanel, async (_event, payload) => {
    const profileId =
      typeof payload === 'string' ? payload : (payload as { profileId?: string })?.profileId
    if (!profileId) throw new Error('workspaces:start rejected — missing profile id')
    await host.directory.start(profileId)
    emitWorkspaces()
  })

  handle(APP_CHANNELS.workspacesStop, requirePanel, async (_event, payload) => {
    const workspaceId =
      typeof payload === 'string' ? payload : (payload as { workspaceId?: string })?.workspaceId
    if (!workspaceId) throw new Error('workspaces:stop rejected — missing workspace id')
    await host.directory.stop(workspaceId)
    emitWorkspaces()
  })

  handle(APP_CHANNELS.workspacesFocusAgent, requirePanel, (_event, payload) => {
    const agentId =
      typeof payload === 'string' ? payload : (payload as { agentId?: string })?.agentId
    if (!agentId) throw new Error('workspaces:focusAgent rejected — missing agent id')
    host.directory.focusAgent(agentId)
  })

  // --- settings & windows ------------------------------------------------

  handle(APP_CHANNELS.settingsGet, requireAppWindow, () =>
    toPanelSettings(host.store.getSettings())
  )

  handle(APP_CHANNELS.settingsYolo, requirePanel, (_event, payload) => {
    const enabled =
      typeof payload === 'boolean' ? payload : (payload as { enabled?: boolean })?.enabled
    if (typeof enabled !== 'boolean') throw new Error('settings:yolo rejected — expected a boolean')
    return toPanelSettings(host.store.setSetting('yoloMaster', enabled))
  })

  handle(APP_CHANNELS.windowsHideAll, requirePanel, () => {
    host.hideAll()
  })

  handle(APP_CHANNELS.dialogPickDirectory, requireAppWindow, (event, payload) => {
    const defaultPath =
      typeof payload === 'string' ? payload : (payload as { defaultPath?: string })?.defaultPath
    return host.pickDirectory(event.sender.id, defaultPath || undefined)
  })

  handle(APP_CHANNELS.profileEditorOpen, requireAppWindow, (_event, payload) => {
    const profileId =
      typeof payload === 'string' ? payload : (payload as { profileId?: string })?.profileId
    host.openProfileEditor(profileId || undefined)
  })

  host.ipcMain.on(APP_CHANNELS.profileEditorClose, ((event: IpcEvent): void => {
    // Only an editor may close itself; nothing else may close editor windows.
    if (host.profileEditorSender(event.sender.id) === null) return
    host.closeProfileEditor(event.sender.id)
  }) as IpcListener)

  unsubscribeDirectory = host.directory.onChange?.(() => emitWorkspaces())

  return {
    emitWorkspaces,
    emitProfiles: () => emitProfiles(host.store.getProfiles()),
    dispose() {
      unsubscribeDirectory?.()
      unsubscribeDirectory = undefined
      healthCache = undefined
      for (const channel of Object.values(APP_CHANNELS)) {
        host.ipcMain.removeAllListeners(channel)
        host.ipcMain.removeHandler(channel)
      }
    }
  }
}

// --- production wiring ---------------------------------------------------

let instance: AppIpc | undefined

/**
 * Register the app IPC. Pass the WorkspaceManager's directory once it exists;
 * without it the workspace channels run on the refusing stub.
 */
export function registerAppIpc(directory?: WorkspaceDirectory): AppIpc {
  if (instance) return instance
  // Every call goes through `settings()` instead of capturing the store once:
  // constructing electron-store touches the config file, and a corrupt file
  // must fail the ONE call that needs it (visible in the window that asked),
  // not the app's IPC registration at boot.
  const store: AppSettingsPort = {
    getProfiles: () => settings().getProfiles(),
    saveProfile: (profile) => settings().saveProfile(profile),
    deleteProfile: (id) => settings().deleteProfile(id),
    effectiveProviders: () => settings().effectiveProviders(),
    getRoleTemplates: () => settings().getRoleTemplates(),
    saveRoleTemplate: (template) => settings().saveRoleTemplate(template),
    getSettings: () => settings().getSettings(),
    setSetting: (key, value) => settings().setSetting(key, value)
  }
  instance = createAppIpc({
    ipcMain: ipcMain as unknown as MinimalIpcMain,
    store,
    directory: directory ?? createStubWorkspaceDirectory(),
    isPanelSender: (id) => isPanelWindowSender(id),
    profileEditorSender: (id) => isProfileEditorWindowSender(id),
    discoverModels: (config) => discoverModels(config),
    checkProviders: (configs) => checkAllProviders(configs),
    async pickDirectory(webContentsId, defaultPath) {
      // Modal to the asking window, so the dialog cannot end up behind the
      // always-on-top panel.
      const owner = BrowserWindow.getAllWindows().find(
        (candidate) => candidate.webContents.id === webContentsId
      )
      const options: Electron.OpenDialogOptions = {
        properties: ['openDirectory'],
        ...(defaultPath ? { defaultPath } : {})
      }
      const result = owner
        ? await dialog.showOpenDialog(owner, options)
        : await dialog.showOpenDialog(options)
      return result.canceled ? null : (result.filePaths[0] ?? null)
    },
    openProfileEditor: (profileId) => {
      openProfileEditorWindow(profileId)
    },
    closeProfileEditor: (webContentsId) => {
      const key = isProfileEditorWindowSender(webContentsId)
      if (key !== null) closeProfileEditorWindow(key)
    },
    broadcast: (channel, payload) => {
      const targets = [getPanelWindow(), ...listProfileEditorWindows().map((entry) => entry.window)]
      for (const win of targets) {
        if (win && !win.webContents.isDestroyed()) win.webContents.send(channel, payload)
      }
    },
    hideAll: () => {
      // TODO(M4): hide every CLI window (and restore in z-order on toggle).
      console.info('[panel] Alles ausblenden — kommt in M4')
    }
  })
  // Env-gated verification hook; a no-op in every normal run.
  armProfileEditorSmoke()
  return instance
}

/** Test seam / restart support. */
export function disposeAppIpc(): void {
  instance?.dispose()
  instance = undefined
}
