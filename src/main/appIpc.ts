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
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { profileRoleIds, type Profile, type RoleTemplate } from '@shared/schema/profile'
import {
  zoneSchema,
  zoneLayoutSchema,
  type Zone,
  type ZoneLayout
} from '@shared/schema/zones'
import {
  allRoleTemplates,
  ORCHESTRATOR_COLOR,
  ORCHESTRATOR_ROLE_ID,
  roleColor
} from '@shared/prompts/roles'
import type { ProviderConfig } from '@shared/schema/provider'
import { normalizeAppearance, type Appearance } from '@shared/appearance'
import type { AppSettings, SettingsStore } from '@main/store/settings'
import { settings } from '@main/store/settings'
import { discoverModels, type ModelDiscoveryResult } from '@main/providers/discovery'
import { checkAllProviders, type ProviderHealth } from '@main/providers/health'
import { focusCliWindow, listCliWindows } from '@main/windows/cliWindow'
import {
  hideAllHotkeyStatus,
  reRegisterHideAllShortcut,
  toggleHideAll,
  type HideAllHotkeyStatus
} from '@main/windows/hideAll'
import { getPanelWindow, isPanelWindowSender } from '@main/windows/panel'
import {
  closeProfileEditorWindow,
  isProfileEditorWindowSender,
  listProfileEditorWindows,
  openProfileEditorWindow
} from '@main/windows/profileEditor'
import {
  closeProviderEditorWindow,
  isProviderEditorWindowSender,
  listProviderEditorWindows,
  openProviderEditorWindow
} from '@main/windows/providerEditor'
import {
  closeSettingsWindow,
  getSettingsWindow,
  isSettingsWindowSender,
  openSettingsWindow
} from '@main/windows/settingsWindow'
import { appUpdater, onUpdateState } from '@main/updater'
import {
  closeZoneOverlayWindows,
  isZoneOverlaySender,
  listZoneOverlayWindows,
  openZoneOverlayWindows,
  zoneOverlayDisplayIds,
  type ZoneOverlaySender
} from '@main/windows/zoneOverlay'
import type { MinimalIpcMain } from './ipc'

export const APP_CHANNELS = {
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
  worktreesList: 'worktrees:list',
  worktreesRemove: 'worktrees:remove',
  settingsGet: 'settings:get',
  settingsYolo: 'settings:yolo',
  settingsSet: 'settings:set',
  windowsHideAll: 'windows:hideAll',
  windowsMinimizePanel: 'windows:minimizePanel',
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
  /**
   * App settings changed — the whole {@link PanelSettings} object, pushed to
   * every app window. The renderer's i18n follows it: the language picker sits
   * in the settings window, but the panel and both editors have to change with
   * it, and asking each of them to poll `settings:get` would make "switch the
   * language" a race against the poll interval.
   */
  eventSettings: 'ev:settings',
  /**
   * How see-through this app is, on its own two channels.
   *
   * Everything else about settings is panel/editor business, but appearance is
   * the one setting a CLI WINDOW has to know — it is the window standing over
   * the wallpaper while somebody types in it. CLI windows are not app windows
   * on the IPC guard and never will be, so instead of widening `settings:get`
   * for them, appearance gets a read anyone may make (four numbers, nothing
   * else) and a push that reaches every window in the app.
   */
  settingsAppearance: 'settings:appearance',
  eventAppearance: 'ev:appearance'
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

/** One stale worktree the panel's cleanup view offers for removal. */
export interface StaleWorktreeSummary {
  path: string
  /** Short branch name (`vertragus/paradiso/caronte`); absent when detached. */
  branch?: string
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
  /**
   * Stale worktrees of this profile's repository — everything under the
   * Vertragus worktree root that no live agent is working in.
   */
  listStaleWorktrees(profileId: string): Promise<StaleWorktreeSummary[]>
  /**
   * Remove ONE stale worktree on the user's explicit click; answers with the
   * refreshed stale list. Live agents' worktrees and anything outside the
   * worktree root are refused, dirty worktrees are refused by git itself, and
   * branches survive — see workspace/worktreeCleanup.
   */
  removeWorktree(profileId: string, worktreePath: string): Promise<StaleWorktreeSummary[]>
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
  const refuse = (): never => {
    throw new Error('Workspace-Manager ist noch nicht verdrahtet.')
  }
  return {
    list: () => [],
    start: refuse,
    stop: refuse,
    focusAgent: (agentId) => focusCliWindow(agentId),
    listStaleWorktrees: async () => refuse(),
    removeWorktree: async () => refuse()
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
  | 'saveProvider'
  | 'deleteProvider'
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

/**
 * The settings the panel and the settings window show; everything else (model
 * memory, panel bounds) stays in the main process.
 */
export interface PanelSettings {
  yoloMaster: boolean
  hideAllHotkey: string
  locale: AppSettings['ui']['locale']
  theme: AppSettings['ui']['theme']
  /** Opacity and glass transparency; see shared/appearance.ts. */
  appearance: Appearance
  autostart: boolean
  updateChannel: AppSettings['updateChannel']
  /**
   * False in a dev run: `app.setLoginItemSettings` would register the Electron
   * binary, not Vertragus. The settings window shows the toggle disabled with
   * that reason instead of pretending the switch did something.
   */
  autostartSupported: boolean
  /**
   * Set only when the global hotkey could NOT be registered. The panel shows it
   * on the hide-all eye — a hotkey that silently does nothing is a support case.
   */
  hideAllHotkeyError?: string
}

/**
 * The settings a window may write. Deliberately a small, flat allow-list rather
 * than "any key of AppSettings": `modelMemory` and `panelBounds` are written by
 * the app itself, and a renderer that could overwrite them would be a way to
 * corrupt state no form ever shows.
 */
export const WRITABLE_SETTINGS = [
  'hideAllHotkey',
  'autostart',
  'updateChannel',
  'theme',
  'locale',
  'appearance'
] as const
export type WritableSetting = (typeof WRITABLE_SETTINGS)[number]

export function isWritableSetting(key: unknown): key is WritableSetting {
  return typeof key === 'string' && (WRITABLE_SETTINGS as readonly string[]).includes(key)
}

/** State of the self-updater as the panel badge and the settings window read it. */
export interface UpdateStatePayload {
  status: string
  currentVersion: string
  availableVersion?: string
  channel: AppSettings['updateChannel']
  progress?: number
  message?: string
}

// --- the zone editor -----------------------------------------------------

/** One entry of the overlay's role palette. */
export interface ZoneEditorRole {
  roleId: string
  label: string
  color: string
}

/** Everything one overlay window needs to draw its display's zones. */
export interface ZoneEditorPayload {
  profileId: string
  profileName: string
  displayId: number
  roles: ZoneEditorRole[]
  /** Only the zones of THIS display; the other overlays own the rest. */
  zones: Zone[]
  /**
   * UI language / appearance for this overlay. Added by the `zones:load`
   * handler, not by {@link zoneEditorPayload} — an overlay cannot call
   * `settings:get`, so the one payload it does receive is where they travel.
   */
  locale?: AppSettings['ui']['locale']
  theme?: AppSettings['ui']['theme']
}

/**
 * The palette and the current rectangles of one display.
 *
 * The orchestrator is always offered even though it has no slot — it is the one
 * window every workspace opens, so "the orchestrator goes here" is the most
 * common zone of all.
 */
export function zoneEditorPayload(
  profile: Profile,
  roleTemplates: readonly RoleTemplate[],
  displayId: number
): ZoneEditorPayload {
  const templates = allRoleTemplates(roleTemplates)
  const roleIds = profileRoleIds(profile)
  return {
    profileId: profile.id,
    profileName: profile.name,
    displayId,
    roles: [
      { roleId: ORCHESTRATOR_ROLE_ID, label: 'Orchestrator', color: ORCHESTRATOR_COLOR },
      ...roleIds.map((roleId, index) => ({
        roleId,
        label: templates.find((template) => template.id === roleId)?.name ?? roleId,
        color: roleColor(roleId, index)
      }))
    ],
    zones: (profile.zones?.zones ?? []).filter((zone) => zone.displayId === displayId)
  }
}

/**
 * The layout to persist after a save.
 *
 * Every display that had an overlay is REPLACED by what that overlay drew
 * (including "nothing", which is how a zone is deleted); zones on displays that
 * were not part of the session — an unplugged monitor, say — are kept
 * untouched. Losing another monitor's layout because it was disconnected while
 * the editor was open would be silent data loss.
 */
export function mergeZoneLayout(
  existing: ZoneLayout | undefined,
  drafts: ReadonlyMap<number, readonly Zone[]>,
  coveredDisplayIds: readonly number[]
): ZoneLayout {
  const covered = new Set([...coveredDisplayIds, ...drafts.keys()])
  const kept = (existing?.zones ?? []).filter((zone) => !covered.has(zone.displayId))
  // By display id, not by the order the overlays happened to report in — the
  // stored layout should not depend on which monitor the user dragged first.
  const drawn = [...drafts.entries()]
    .sort(([left], [right]) => left - right)
    .flatMap(([, zones]) => zones)
  return zoneLayoutSchema.parse({ zones: [...kept, ...drawn] })
}

// --- quitting ------------------------------------------------------------

/**
 * How many agents the ✕ in the panel would kill.
 *
 * Only workspaces that are still active count: a card whose orchestrator is
 * gone stays visible so the user can read it, but nothing in it is running.
 */
export function runningAgentCount(workspaces: readonly WorkspaceSummary[]): number {
  return workspaces
    .filter((workspace) => workspace.active)
    .reduce(
      (sum, workspace) =>
        sum + workspace.agents.filter((agent) => agent.state !== 'stopped').length,
      0
    )
}

/** Copy of the native quit confirmation; exported so the wording is testable. */
export function quitConfirmationText(runningAgents: number): {
  message: string
  detail: string
} {
  const subject = runningAgents === 1 ? '1 Agent läuft' : `${runningAgents} Agenten laufen`
  return {
    message: `${subject} noch — Vertragus beenden?`,
    detail: 'Alle Agenten-Prozesse werden gestoppt.'
  }
}

/** Parse what an overlay sent, forcing the display it is actually running on. */
function parseDraftZones(payload: unknown, displayId: number): Zone[] {
  const raw = Array.isArray(payload) ? payload : (payload as { zones?: unknown })?.zones
  if (!Array.isArray(raw)) throw new Error('zones payload rejected — expected an array of zones')
  return raw.map((entry) => zoneSchema.parse({ ...(entry as object), displayId }))
}

export interface AppIpcHost {
  ipcMain: MinimalIpcMain
  store: AppSettingsPort
  directory: WorkspaceDirectory
  isPanelSender(webContentsId: number): boolean
  /** Editor key (profile id, or `new`) behind this webContents, or null. */
  profileEditorSender(webContentsId: number): string | null
  /** Editor key (provider id, or `new`) behind this webContents, or null. */
  providerEditorSender(webContentsId: number): string | null
  discoverModels(config: ProviderConfig): Promise<ModelDiscoveryResult>
  checkProviders(configs: readonly ProviderConfig[]): Promise<ProviderHealth[]>
  pickDirectory(webContentsId: number, defaultPath?: string): Promise<string | null>
  openProfileEditor(profileId?: string): void
  closeProfileEditor(webContentsId: number): void
  openProviderEditor(providerId?: string): void
  closeProviderEditor(webContentsId: number): void
  /** Push to every app window (panel + open editors). */
  broadcast(channel: string, payload: unknown): void
  /**
   * Push to EVERY window — CLI and zone overlay windows included. Settings and
   * appearance travel this way (see {@link APP_CHANNELS.eventSettings} and
   * {@link APP_CHANNELS.eventAppearance}): those windows cannot call
   * settings:get but still follow live locale/theme/appearance flips. Optional
   * so a test host that does not care falls back to {@link AppIpcHost.broadcast}.
   */
  broadcastAll?(channel: string, payload: unknown): void
  /** Hide every CLI window and editor; toggling again restores them. */
  hideAll(): void
  /**
   * Minimize the panel itself — the one window hide-all deliberately never
   * touches, and therefore the one that needs its own way down to the taskbar.
   */
  minimizePanel(): void
  /**
   * Native "N agents are still running" confirmation. Resolves true when the
   * user chose to quit. Only asked when something is actually running.
   */
  confirmQuit(runningAgents: number): Promise<boolean>
  /** Shut the app down. `before-quit` is what stops the agents cleanly. */
  quit(): void
  /** Open the zone overlay on every display for this profile. */
  openZoneOverlays(profileId: string): void
  closeZoneOverlays(): void
  /** Profile + display behind this webContents, or null for anything else. */
  zoneOverlaySender(webContentsId: number): ZoneOverlaySender | null
  /** Displays currently covered by an overlay — see {@link mergeZoneLayout}. */
  zoneOverlayDisplayIds(): number[]
  /** Result of the last global-hotkey registration, if it already happened. */
  hotkeyStatus?(): HideAllHotkeyStatus | undefined
  now?(): number

  // --- the settings window and the updater --------------------------------

  /** True for the one settings window; see windows/settingsWindow.ts. */
  isSettingsSender(webContentsId: number): boolean
  openSettings(): void
  closeSettings(): void
  /**
   * Take the new accelerator immediately. The returned status is what the form
   * shows inline — a hotkey that is only tried at the next boot is untestable
   * for the user.
   */
  reRegisterHotkey(hotkey: string): HideAllHotkeyStatus
  /** Register/unregister the login item. False when the platform cannot. */
  setAutostart(enabled: boolean): void
  autostartSupported(): boolean
  updateState(): UpdateStatePayload
  setUpdateChannel(channel: AppSettings['updateChannel']): Promise<UpdateStatePayload>
  checkForUpdates(): Promise<UpdateStatePayload>
  /** Restart into the downloaded update; throws while nothing is ready. */
  installUpdate(): void
  /** Push channel for update state. Without it the badge only refreshes on demand. */
  onUpdateState?(listener: (state: UpdateStatePayload) => void): () => void
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

export function toPanelSettings(
  value: AppSettings,
  hotkey?: HideAllHotkeyStatus,
  autostartSupported = true
): PanelSettings {
  return {
    yoloMaster: value.yoloMaster,
    hideAllHotkey: value.hideAllHotkey,
    locale: value.ui.locale,
    theme: value.ui.theme,
    appearance: value.ui.appearance,
    autostart: value.autostart,
    updateChannel: value.updateChannel,
    autostartSupported,
    ...(hotkey && !hotkey.registered ? { hideAllHotkeyError: hotkey.error ?? '' } : {})
  }
}

export function createAppIpc(host: AppIpcHost): AppIpc {
  const now = host.now ?? (() => Date.now())
  let healthCache: { at: number; health: ProviderHealth[] } | undefined
  let unsubscribeDirectory: (() => void) | undefined
  let unsubscribeUpdates: (() => void) | undefined
  /** What each overlay has drawn so far, keyed by display. Lives per session. */
  const zoneDrafts = new Map<number, Zone[]>()

  /** Panel-only: workspaces, settings, hide-all. */
  const requirePanel = (event: IpcEvent, channel: string): void => {
    if (!host.isPanelSender(event.sender.id)) {
      throw new Error(`${channel} rejected — sender is not the panel window`)
    }
  }

  /** Panel or an editor window: profiles, roles, providers, models, folder pick. */
  const requireAppWindow = (event: IpcEvent, channel: string): void => {
    if (host.isPanelSender(event.sender.id)) return
    if (host.profileEditorSender(event.sender.id) !== null) return
    if (host.providerEditorSender(event.sender.id) !== null) return
    if (host.isSettingsSender(event.sender.id)) return
    throw new Error(`${channel} rejected — sender is not a panel or editor window`)
  }

  /**
   * Panel or settings window: writing app settings and driving the updater.
   * The profile editor is deliberately NOT included — it edits one record, and
   * nothing in it should be able to change the global hotkey.
   */
  const requireSettingsWindow = (event: IpcEvent, channel: string): void => {
    if (host.isPanelSender(event.sender.id)) return
    if (host.isSettingsSender(event.sender.id)) return
    throw new Error(`${channel} rejected — sender is not the panel or the settings window`)
  }

  const panelSettings = (value?: AppSettings): PanelSettings =>
    toPanelSettings(
      value ?? host.store.getSettings(),
      host.hotkeyStatus?.(),
      host.autostartSupported()
    )

  /** Zone overlays only: reading and writing a profile's zone layout. */
  const requireZoneOverlay = (event: IpcEvent, channel: string): ZoneOverlaySender => {
    const sender = host.zoneOverlaySender(event.sender.id)
    if (!sender) throw new Error(`${channel} rejected — sender is not a zone overlay window`)
    return sender
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
  const emitSettings = (value: PanelSettings): void => {
    // Settings go to EVERY window: CLI and zone overlays cannot call
    // settings:get, yet they follow live locale/theme flips over `ev:settings`.
    // Appearance rides its own channel in the same tick — the CLI windows are
    // the ones standing over the wallpaper. Both pushes carry the same value,
    // and applying either twice in an app window is idempotent.
    ;(host.broadcastAll ?? host.broadcast)(APP_CHANNELS.eventSettings, value)
    ;(host.broadcastAll ?? host.broadcast)(APP_CHANNELS.eventAppearance, value.appearance)
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

  /**
   * Announce the effective provider list. Every window that shows providers
   * (the profile editor's picker, above all) refreshes from this instead of
   * finding out on its next reopen — a custom provider you just created must
   * appear in the dropdown you created it from.
   */
  const emitProviders = (): void => {
    host.broadcast(APP_CHANNELS.eventProviders, host.store.effectiveProviders())
  }

  /**
   * Write a provider descriptor. This is the record that decides how a CLI is
   * started, so it is parsed strictly by the store and a rejection travels back
   * to the editor as an error it can pin on a field — never a silent drop.
   *
   * Saving under a PRESET id is not a special case: `effectiveProviders` lets a
   * stored entry replace its preset, which is exactly what "edit a built-in"
   * means. The way back is `providers:delete`.
   */
  handle(APP_CHANNELS.providersSave, requireAppWindow, (_event, payload) => {
    host.store.saveProvider(payload)
    // A new or edited CLI has a different `--version` answer than the one in
    // the cache; keeping it would show a fresh provider as "not installed".
    healthCache = undefined
    const configs = host.store.effectiveProviders()
    emitProviders()
    return configs
  })

  /**
   * Delete a stored provider — which for a preset id is RESET, not removal:
   * dropping the override makes the built-in reappear in `effectiveProviders`.
   * One channel for both because it is one operation on the store.
   */
  handle(APP_CHANNELS.providersDelete, requireAppWindow, (_event, payload) => {
    const id = typeof payload === 'string' ? payload : (payload as { id?: string })?.id
    if (!id) throw new Error('providers:delete rejected — missing provider id')
    host.store.deleteProvider(id)
    healthCache = undefined
    const configs = host.store.effectiveProviders()
    emitProviders()
    return configs
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

  // --- worktree cleanup ----------------------------------------------------

  handle(APP_CHANNELS.worktreesList, requirePanel, (_event, payload) => {
    const profileId =
      typeof payload === 'string' ? payload : (payload as { profileId?: string })?.profileId
    if (!profileId) throw new Error('worktrees:list rejected — missing profile id')
    return host.directory.listStaleWorktrees(profileId)
  })

  handle(APP_CHANNELS.worktreesRemove, requirePanel, (_event, payload) => {
    const body = (payload ?? {}) as { profileId?: string; path?: string }
    if (!body.profileId) throw new Error('worktrees:remove rejected — missing profile id')
    if (!body.path) throw new Error('worktrees:remove rejected — missing worktree path')
    // Whether this path may go at all is decided in the directory (stale-list
    // membership) and by git (dirty worktrees refuse) — never here.
    return host.directory.removeWorktree(body.profileId, body.path)
  })

  // --- settings & windows ------------------------------------------------

  handle(APP_CHANNELS.settingsGet, requireAppWindow, () => panelSettings())

  /**
   * Appearance, readable from ANY window — the one deliberate hole in the
   * window-type authorization above, and a narrow one: it answers four numbers
   * and a boolean that are already visible as pixels in every window on the
   * screen. A CLI window needs it to paint its first frame at the user's
   * opacity instead of flashing the default and correcting itself.
   */
  handle(APP_CHANNELS.settingsAppearance, () => undefined, () => host.store.getSettings().ui.appearance)

  handle(APP_CHANNELS.settingsYolo, requirePanel, (_event, payload) => {
    const enabled =
      typeof payload === 'boolean' ? payload : (payload as { enabled?: boolean })?.enabled
    if (typeof enabled !== 'boolean') throw new Error('settings:yolo rejected — expected a boolean')
    const next = panelSettings(host.store.setSetting('yoloMaster', enabled))
    emitSettings(next)
    return next
  })

  /**
   * The settings form's single write path.
   *
   * Three of the five keys have an effect that must happen NOW, not at the next
   * boot — the hotkey, the login item and the update channel. They are applied
   * here rather than in the renderer, so the same guarantee holds no matter who
   * calls the channel.
   *
   * A hotkey the OS refuses is still stored: the value the user typed stays in
   * the field, and the reason travels back in `hideAllHotkeyError` where both
   * the form and the panel's eye already show it. Dropping the write instead
   * would leave the form showing a value that is not what is stored.
   */
  handle(APP_CHANNELS.settingsSet, requireSettingsWindow, async (_event, payload) => {
    const body = (payload ?? {}) as { key?: unknown; value?: unknown }
    if (!isWritableSetting(body.key)) {
      throw new Error(`settings:set rejected — ${String(body.key)} is not user-writable`)
    }
    // Bound before the closure: TypeScript drops a property narrowing at the
    // function boundary, and the exhaustiveness check below depends on it.
    const key = body.key

    const written = await (async (): Promise<PanelSettings> => {
      switch (key) {
        case 'hideAllHotkey': {
          const next = host.store.setSetting('hideAllHotkey', body.value as string)
          host.reRegisterHotkey(next.hideAllHotkey)
          return panelSettings(next)
        }
        case 'autostart': {
          if (typeof body.value !== 'boolean') {
            throw new Error('settings:set rejected — autostart expects a boolean')
          }
          const next = host.store.setSetting('autostart', body.value)
          if (host.autostartSupported()) host.setAutostart(next.autostart)
          return panelSettings(next)
        }
        case 'updateChannel': {
          if (body.value !== 'main' && body.value !== 'stable') {
            throw new Error('settings:set rejected — updateChannel expects main or stable')
          }
          // The updater persists the channel itself (it has to reconfigure at
          // the same moment), so this path must not write it a second time.
          await host.setUpdateChannel(body.value)
          return panelSettings()
        }
        case 'appearance': {
          // Clamped, not refused: every field is a slider, so an out-of-range
          // value is a control that went too far, never a typo worth an error.
          // The store's schema clamps too — this is the boundary check, the
          // same as the `boolean` and enum guards above, and it is what makes
          // the value the other windows are pushed the value that was stored.
          const ui = { ...host.store.getSettings().ui, appearance: normalizeAppearance(body.value) }
          return panelSettings(host.store.setSetting('ui', ui))
        }
        case 'theme':
        case 'locale': {
          // `ui` is one strict object in the schema: read, patch, write back.
          const ui = { ...host.store.getSettings().ui, [key]: body.value }
          return panelSettings(host.store.setSetting('ui', ui))
        }
        default: {
          // Unreachable while WRITABLE_SETTINGS and this switch agree; the
          // `never` binding is what makes a new key a compile error here.
          const unhandled: never = key
          throw new Error(`settings:set rejected — ${String(unhandled)} has no write path`)
        }
      }
    })()

    // Every window that shows a setting learns about it in the same tick. The
    // caller still gets the object back: the settings form must not have to
    // wait for its own broadcast to redraw the field the user just touched.
    emitSettings(written)
    return written
  })

  handle(APP_CHANNELS.windowsHideAll, requirePanel, () => {
    host.hideAll()
  })

  /**
   * The panel's −. Distinct from hide-all on purpose: hide-all clears the
   * agents off the screen and leaves the panel standing (it is the way back),
   * so "get this strip out of my way" had nowhere to go before. The taskbar
   * entry brings it back — the panel is the one window with `skipTaskbar` off.
   */
  handle(APP_CHANNELS.windowsMinimizePanel, requirePanel, () => {
    host.minimizePanel()
  })

  /**
   * The panel's ✕. Quitting Vertragus kills every agent process, so it asks
   * first — but only when there is something to lose. Returns false when the
   * user cancelled, so the panel can tell "declined" from "about to die".
   */
  handle(APP_CHANNELS.appQuit, requirePanel, async () => {
    const running = runningAgentCount(host.directory.list())
    if (running > 0 && !(await host.confirmQuit(running))) return false
    host.quit()
    return true
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

  /**
   * Open the provider editor. Reachable from the panel AND from the profile
   * editor, because "+ Eigener Provider …" sits in the provider dropdown —
   * the moment you notice a CLI is missing is the moment you are picking one.
   */
  handle(APP_CHANNELS.providerEditorOpen, requireAppWindow, (_event, payload) => {
    const providerId =
      typeof payload === 'string' ? payload : (payload as { providerId?: string })?.providerId
    host.openProviderEditor(providerId || undefined)
  })

  host.ipcMain.on(APP_CHANNELS.providerEditorClose, ((event: IpcEvent): void => {
    if (host.providerEditorSender(event.sender.id) === null) return
    host.closeProviderEditor(event.sender.id)
  }) as IpcListener)

  // --- the settings window -----------------------------------------------

  handle(APP_CHANNELS.settingsWindowOpen, requirePanel, () => {
    host.openSettings()
  })

  host.ipcMain.on(APP_CHANNELS.settingsWindowClose, ((event: IpcEvent): void => {
    // Only the settings window may close itself.
    if (!host.isSettingsSender(event.sender.id)) return
    host.closeSettings()
  }) as IpcListener)

  // --- self-update --------------------------------------------------------

  handle(APP_CHANNELS.updatesGet, requireSettingsWindow, () => host.updateState())

  handle(APP_CHANNELS.updatesCheck, requireSettingsWindow, () => host.checkForUpdates())

  /**
   * The panel badge's click target. Restarting takes every running agent with
   * it, which is exactly why nothing here installs on its own — see
   * main/updater.ts.
   */
  handle(APP_CHANNELS.updatesInstall, requireSettingsWindow, () => {
    host.installUpdate()
  })

  // --- zones -------------------------------------------------------------

  handle(APP_CHANNELS.zonesEdit, requireAppWindow, (_event, payload) => {
    const profileId =
      typeof payload === 'string' ? payload : (payload as { profileId?: string })?.profileId
    if (!profileId) throw new Error('zones:edit rejected — missing profile id')
    // A profile that is not saved yet has nothing to attach zones to.
    if (!host.store.getProfiles().some((profile) => profile.id === profileId)) {
      throw new Error(`zones:edit rejected — unknown profile ${profileId}`)
    }
    zoneDrafts.clear()
    host.openZoneOverlays(profileId)
  })

  handle(APP_CHANNELS.zonesLoad, requireZoneOverlay, (event) => {
    const sender = requireZoneOverlay(event, APP_CHANNELS.zonesLoad)
    const profile = host.store.getProfiles().find((entry) => entry.id === sender.profileId)
    if (!profile) throw new Error(`zones:load rejected — unknown profile ${sender.profileId}`)
    // The overlay is not an "app window" on the settings guard, so this is the
    // only channel that can tell it which language and theme to draw in at open.
    return {
      ...zoneEditorPayload(profile, host.store.getRoleTemplates(), sender.displayId),
      locale: host.store.getSettings().ui.locale,
      theme: host.store.getSettings().ui.theme
    }
  })

  handle(APP_CHANNELS.zonesSave, requireZoneOverlay, (event, payload) => {
    const sender = requireZoneOverlay(event, APP_CHANNELS.zonesSave)
    const body = (payload ?? {}) as { profileId?: string; zones?: unknown }
    if (body.profileId && body.profileId !== sender.profileId) {
      throw new Error('zones:save rejected — profile does not belong to this overlay')
    }
    const profile = host.store.getProfiles().find((entry) => entry.id === sender.profileId)
    if (!profile) throw new Error(`zones:save rejected — unknown profile ${sender.profileId}`)

    // The acting overlay's own rectangles are the freshest version of its
    // display; the other displays come from the drafts they pushed while the
    // user was dragging.
    zoneDrafts.set(sender.displayId, parseDraftZones(body.zones, sender.displayId))
    const zones = mergeZoneLayout(profile.zones, zoneDrafts, host.zoneOverlayDisplayIds())
    const profiles = host.store.saveProfile({ ...profile, zones })
    zoneDrafts.clear()
    emitProfiles(profiles)
    host.closeZoneOverlays()
    return zones
  })

  host.ipcMain.on(APP_CHANNELS.zonesDraft, ((event: IpcEvent, payload?: unknown): void => {
    const sender = host.zoneOverlaySender(event.sender.id)
    if (!sender) return
    // Fire-and-forget from a drag: a malformed draft is dropped, never thrown —
    // the save path validates again and is the one that can report.
    try {
      zoneDrafts.set(sender.displayId, parseDraftZones(payload, sender.displayId))
    } catch {
      /* ignore */
    }
  }) as IpcListener)

  host.ipcMain.on(APP_CHANNELS.zonesCancel, ((event: IpcEvent): void => {
    if (host.zoneOverlaySender(event.sender.id) === null) return
    zoneDrafts.clear()
    host.closeZoneOverlays()
  }) as IpcListener)

  unsubscribeDirectory = host.directory.onChange?.(() => emitWorkspaces())
  unsubscribeUpdates = host.onUpdateState?.((state) => {
    host.broadcast(APP_CHANNELS.eventUpdate, state)
  })

  return {
    emitWorkspaces,
    emitProfiles: () => emitProfiles(host.store.getProfiles()),
    dispose() {
      unsubscribeDirectory?.()
      unsubscribeDirectory = undefined
      unsubscribeUpdates?.()
      unsubscribeUpdates = undefined
      healthCache = undefined
      zoneDrafts.clear()
      for (const channel of Object.values(APP_CHANNELS)) {
        host.ipcMain.removeAllListeners(channel)
        host.ipcMain.removeHandler(channel)
      }
    }
  }
}

// --- production wiring ---------------------------------------------------

let instance: AppIpc | undefined

/** The windows that may see app state: the panel, the editors, the settings. */
function appWindows(): (BrowserWindow | null)[] {
  return [
    getPanelWindow(),
    ...listProfileEditorWindows().map((entry) => entry.window),
    ...listProviderEditorWindows().map((entry) => entry.window),
    getSettingsWindow()
  ]
}

/** Push to whatever of those windows is still alive. */
function send(targets: readonly (BrowserWindow | null)[], channel: string, payload: unknown): void {
  for (const win of targets) {
    if (win && !win.webContents.isDestroyed()) win.webContents.send(channel, payload)
  }
}

/**
 * Register the app IPC. Pass the WorkspaceManager's directory once it exists;
 * without it the workspace channels run on the refusing stub.
 *
 * Registering twice is a no-op that keeps the FIRST registration — `ipcMain`
 * allows one handler per channel, so a second `createAppIpc` would throw and
 * take the boot with it. The guard means the directory is bound exactly once:
 * whoever calls first decides whether the panel gets the real manager or the
 * stub, which is why the app entry must call this only after the manager is
 * built (or in its catch). Nothing else in the app may call it — window smoke
 * hooks in particular live in the app entry, next to the other boot hooks.
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
    saveProvider: (config) => settings().saveProvider(config),
    deleteProvider: (id) => settings().deleteProvider(id),
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
    providerEditorSender: (id) => isProviderEditorWindowSender(id),
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
    openProviderEditor: (providerId) => {
      openProviderEditorWindow(providerId)
    },
    closeProviderEditor: (webContentsId) => {
      const key = isProviderEditorWindowSender(webContentsId)
      if (key !== null) closeProviderEditorWindow(key)
    },
    broadcast: (channel, payload) => {
      send(appWindows(), channel, payload)
    },
    broadcastAll: (channel, payload) => {
      // CLI and zone overlay windows are not app windows on the IPC guard,
      // but they still need live locale/theme flips and the appearance push.
      send(
        [
          ...appWindows(),
          ...listCliWindows().map((entry) => entry.window),
          ...listZoneOverlayWindows().map((entry) => entry.window)
        ],
        channel,
        payload
      )
    },
    hideAll: () => {
      toggleHideAll()
    },
    minimizePanel: () => {
      getPanelWindow()?.minimize()
    },
    async confirmQuit(runningAgents) {
      const { message, detail } = quitConfirmationText(runningAgents)
      const owner = getPanelWindow()
      const options: Electron.MessageBoxOptions = {
        type: 'warning',
        // Cancel is the default: an accidental Enter must not kill a team.
        buttons: ['Beenden', 'Abbrechen'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        title: 'Vertragus beenden',
        message,
        detail
      }
      const result = owner
        ? await dialog.showMessageBox(owner, options)
        : await dialog.showMessageBox(options)
      return result.response === 0
    },
    quit: () => app.quit(),
    openZoneOverlays: (profileId) => {
      openZoneOverlayWindows(profileId)
    },
    closeZoneOverlays: () => closeZoneOverlayWindows(),
    zoneOverlaySender: (id) => isZoneOverlaySender(id),
    zoneOverlayDisplayIds: () => zoneOverlayDisplayIds(),
    hotkeyStatus: () => hideAllHotkeyStatus(),

    isSettingsSender: (id) => isSettingsWindowSender(id),
    openSettings: () => {
      openSettingsWindow()
    },
    closeSettings: () => closeSettingsWindow(),
    reRegisterHotkey: (hotkey) => reRegisterHideAllShortcut(hotkey),
    setAutostart: (enabled) => {
      app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: false })
    },
    // In a dev run the login item would point at the Electron binary, not at
    // Vertragus — the settings window says so instead of writing a broken entry.
    autostartSupported: () => app.isPackaged,
    updateState: () => appUpdater().state(),
    setUpdateChannel: (channel) => appUpdater().setChannel(channel),
    checkForUpdates: () => appUpdater().check(),
    installUpdate: () => appUpdater().install(),
    onUpdateState: (listener) => onUpdateState(listener)
  })
  return instance
}

/** Test seam / restart support. */
export function disposeAppIpc(): void {
  instance?.dispose()
  instance = undefined
}
