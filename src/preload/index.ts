import { contextBridge, ipcRenderer } from 'electron'
import type { Profile, RoleTemplate } from '@shared/schema/profile'
import type { ProviderConfig } from '@shared/schema/provider'
import type { ModelLearning, RepoNote, RunRetro } from '@shared/schema/retro'
import type { Zone, ZoneLayout } from '@shared/schema/zones'
import type { ExtraMcpServer } from '@shared/schema/mcpServer'
import type { Appearance } from '@shared/appearance'
import type { BindOption, RemoteClientInfo, RemoteStatus } from '@shared/remote/types'

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
  task: 'terminal:task',
  windowClose: 'window:close',
  windowMinimize: 'window:minimize',
  windowMaximize: 'window:maximize'
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
  /** True while the window fills its screen — the title bar's glyph follows it. */
  maximized: boolean
  /** Current task note at attach time; later changes arrive via onTask. */
  task?: string
}

export interface TerminalDataEvent {
  agentId: string
  data: string
}

/** A new current-task note for this window's agent — the hover card follows it. */
export interface TerminalTaskEvent {
  agentId: string
  task?: string
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
  /** The agent got a new assignment — the title bar's hover card follows it. */
  onTask: (listener: (event: TerminalTaskEvent) => void): (() => void) => {
    const handler = (_event: unknown, payload: TerminalTaskEvent): void => listener(payload)
    ipcRenderer.on(CHANNELS.task, handler)
    return () => {
      ipcRenderer.removeListener(CHANNELS.task, handler)
    }
  },
  /** Close this window only — the agent keeps running. */
  closeWindow: (): void => {
    ipcRenderer.send(CHANNELS.windowClose)
  },
  /** Minimize this window — the agent keeps running and the window stays registered. */
  minimizeWindow: (): void => {
    ipcRenderer.send(CHANNELS.windowMinimize)
  },
  /**
   * Grow this window to fill its screen, or shrink it back into its zone.
   * Answers with the state it ended up in, so the button can draw the other
   * glyph without keeping a second copy of the truth.
   */
  toggleMaximizeWindow: (): Promise<boolean> => ipcRenderer.invoke(CHANNELS.windowMaximize)
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
  providersAuthStatus: 'providers:authStatus',
  providersSave: 'providers:save',
  providersDelete: 'providers:delete',
  modelsDiscover: 'models:discover',
  workspacesList: 'workspaces:list',
  workspacesStart: 'workspaces:start',
  workspacesSendToOrchestrator: 'workspaces:sendToOrchestrator',
  workspacesGoal: 'workspaces:goal',
  workspacesResume: 'workspaces:resume',
  workspacesStop: 'workspaces:stop',
  workspacesSucceedOrchestrator: 'workspaces:succeedOrchestrator',
  workspacesFocusAgent: 'workspaces:focusAgent',
  workspacesFocus: 'workspaces:focus',
  workspacesCloseAgent: 'workspaces:closeAgent',
  workspacesAnswerQuestion: 'workspaces:answerQuestion',
  workspacesUserMessage: 'workspaces:userMessage',
  workspacesPromoteAgent: 'workspaces:promoteAgent',
  workspacesOpenRunFolder: 'workspaces:openRunFolder',
  worktreesList: 'worktrees:list',
  worktreesRemove: 'worktrees:remove',
  retroList: 'retro:list',
  retroLearnings: 'retro:learnings',
  retroDeleteLearning: 'retro:deleteLearning',
  retroRepoNotes: 'retro:repoNotes',
  retroDeleteRepoNote: 'retro:deleteRepoNote',
  settingsGet: 'settings:get',
  settingsYolo: 'settings:yolo',
  settingsSet: 'settings:set',
  windowsHideAll: 'windows:hideAll',
  windowsMinimizePanel: 'windows:minimizePanel',
  appQuit: 'app:quit',
  voiceStatus: 'voice:status',
  voiceSetEnabled: 'voice:setEnabled',
  voicePcm: 'voice:pcm',
  voiceAudio: 'voice:audio',
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
  zonesPickDisplay: 'zones:pickDisplay',
  eventProfiles: 'ev:profiles',
  eventProviders: 'ev:providers',
  eventWorkspaces: 'ev:workspaces',
  eventUpdate: 'ev:update',
  eventSettings: 'ev:settings',
  eventVoice: 'ev:voice',
  settingsAppearance: 'settings:appearance',
  eventAppearance: 'ev:appearance',
  // Remote access — settings-window-only in main; see main/remote/ipc.ts.
  remoteGet: 'remote:get',
  remoteSet: 'remote:set',
  remoteRegenerateToken: 'remote:regenerateToken',
  remoteClients: 'remote:clients',
  remoteRevokeClient: 'remote:revokeClient',
  remoteInterfaces: 'remote:interfaces',
  eventRemote: 'ev:remote'
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
  /**
   * Current task for the row's hover card. Subagents: last start_agent /
   * follow-up send_to_agent. Orchestrator: latest submitted user CLI note.
   */
  taskText?: string
  /**
   * F: 'orchestrator' for the root row, 'lead' for sub-orchestrators, the
   * role id otherwise. Drives the panel's indentation and lead styling.
   */
  kind?: string
  /** F: the lead this agent works under; absent for direct children. */
  parentId?: string

  /**
   * True while this agent's CLI window is on screen. A finished agent whose
   * window is still open can be dismissed with ✕; clicking the row after
   * that reopens the scrollback so the last task stays readable.
   */
  windowOpen?: boolean
  pendingQuestion?: string
  /** Id of that open question — what `answerQuestion` addresses. */
  pendingQuestionId?: string
}

/** S4: one row of the run's task board. Mirrors main's WorkspaceTaskSummary. */
export interface WorkspaceTaskSummary {
  taskId: string
  subject: string
  /** Tombstones never travel — the card shows the living plan only. */
  status: 'pending' | 'in_progress' | 'completed'
  /** Agent id of the owner; the card resolves it to the Commedia name. */
  ownerAgentId?: string
  blockedBy: string[]
  /** pending AND every blockedBy completed — decided by the host's board. */
  ready: boolean
}

export interface WorkspaceSummary {
  workspaceId: string
  name: string
  profileId: string
  profileName?: string
  active: boolean
  /**
   * Last delegated assignment, when still populated. The workspace hover uses
   * {@link goalText}, not this.
   */
  taskText?: string
  /** User's workspace goal (full text); absent = "no goal" hint on the card. */
  goalText?: string
  /** C5: orchestrator alive but silent on its tools — the card shows a hint. */
  orchestratorIdle?: boolean
  /** C6: a successor orchestrator is spawning — the card shows a badge. */
  successionInProgress?: true
  /** D3: the orchestrator's open ask_user question (answer with agentId "user"). */
  userQuestion?: { questionId: string; question: string }
  agents: WorkspaceAgentSummary[]
  /** S4: the run's task board, capped and tombstone-free. Absent = no plan yet. */
  tasks?: WorkspaceTaskSummary[]
  /**
   * S4: counts over the WHOLE plan, not over the capped {@link tasks} — the
   * card must never derive progress from the rows that happened to fit.
   */
  taskTotal?: number
  taskDone?: number
  /** A3: the run's pull request (or why there is none) once auto-PR has run. */
  pullRequest?: { ok: boolean; url?: string; message?: string }
}

/** One stale worktree the panel's cleanup view offers for removal. */
export interface StaleWorktreeSummary {
  path: string
  /** Short branch name; absent for a detached worktree. */
  branch?: string
}

/** Retro records, re-exported so renderer code imports them from the bridge. */
export type { ModelLearning, RepoNote, RunRetro } from '@shared/schema/retro'

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

/** WP-7: how a provider answered its own login question. */
export type ProviderAuthState = 'logged-in' | 'logged-out' | 'unknown'

/** Login state of one provider (see main/providers/authStatus.ts). */
export interface ProviderAuthStatus {
  id: string
  state: ProviderAuthState
  /** The probe's first output line, or the error that replaced it. */
  detail?: string
  /** `cursor-agent login`, composed from the descriptor. Absent = none declared. */
  loginCommand?: string
  checkedAt: number
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
  /** D4: the effective subagent tier — mirrors main/appIpc. */
  agentPolicy: AgentPolicy
  hideAllHotkey: string
  locale: 'de' | 'en'
  theme: 'dark' | 'light'
  /** Window opacity and glass transparency; see @shared/appearance. */
  appearance: Appearance
  /** When a window or zone is moved, neighbors shrink and fill the gap. */
  reflowNeighbors: boolean
  /** WP-7: the first-run card was closed by hand — the panel honours it. */
  onboardingDismissed: boolean
  autostart: boolean
  updateChannel: UpdateChannel
  /** False in a dev run — the login item would point at the Electron binary. */
  autostartSupported: boolean
  /** Present only when the global hide-all hotkey could not be registered. */
  hideAllHotkeyError?: string
  voiceEnabled: boolean
  voiceWakePhrase: string
  voiceVoiceId: string
  /** Whether a key is stored. The raw key never appears here. */
  voiceApiKeySet: boolean
  /** Extra MCP servers attached next to Vertragus on the next spawn. */
  mcpServers: ExtraMcpServer[]
}

export type VoicePhase = 'idle' | 'listening' | 'engaged' | 'error'

export interface VoiceStatusPayload {
  phase: VoicePhase
  enabled: boolean
  error?: string
}

export interface VoiceEventPayload {
  phase: VoicePhase
  transcript?: string
  error?: string
}

export type UpdateChannel = 'main' | 'stable'

/** D4: how far a subagent may act on its own; mirrors @shared/agentPolicy. */
export type AgentPolicy = 'yolo' | 'ask-user' | 'ask-orchestrator'

/** The keys the settings form may write; see WRITABLE_SETTINGS in main/appIpc. */
export type WritableSetting =
  | 'hideAllHotkey'
  | 'autostart'
  | 'updateChannel'
  | 'theme'
  | 'locale'
  | 'appearance'
  | 'reflowNeighbors'
  | 'voice'
  | 'agentPolicy'
  | 'onboardingDismissed'
  | 'mcpServers'

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

/** One attached monitor as the zone overlay picker labels it. */
export interface ZoneDisplayInfo {
  id: number
  label: string
  width: number
  height: number
  primary: boolean
}

/** What one zone overlay window needs to draw its display. */
export interface ZoneEditorPayload {
  profileId: string
  profileName: string
  displayId: number
  roles: ZoneEditorRole[]
  zones: Zone[]
  displays: ZoneDisplayInfo[]
  /** True while this overlay is asking which screen Vertragus should use. */
  selectingDisplay: boolean
  /** UI language — an overlay window may not call `settings:get` itself. */
  locale?: 'de' | 'en'
  /** Appearance — same constraint as locale. */
  theme?: 'dark' | 'light'
  /** Neighbors fill the gap when a zone is dragged — same constraint as locale. */
  reflowNeighbors?: boolean
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
  /**
   * The effective providers with their health probe. `refresh` skips the main
   * process' 30 s health cache — reserved for an explicit user gesture (the
   * first-run card's ⟳); every read that happens on a render omits it.
   */
  listProviders: (options?: { refresh?: boolean }): Promise<ProviderListEntry[]> =>
    ipcRenderer.invoke(APP.providersList, options),
  /**
   * WP-7: login state per provider. Shells out to the CLIs' own status
   * commands, so it is called on demand (the first-run card, its ⟳) and never
   * on a render.
   */
  listProviderAuth: (): Promise<ProviderAuthStatus[]> =>
    ipcRenderer.invoke(APP.providersAuthStatus),
  discoverModels: (providerId: string): Promise<ModelDiscoveryResult> =>
    ipcRenderer.invoke(APP.modelsDiscover, { providerId }),
  listWorkspaces: (): Promise<WorkspaceSummary[]> => ipcRenderer.invoke(APP.workspacesList),
  /** Start a workspace; `goal` (optional) is seeded into the orchestrator. */
  startWorkspace: (profileId: string, goal?: string): Promise<void> =>
    ipcRenderer.invoke(APP.workspacesStart, { profileId, ...(goal ? { goal } : {}) }),
  /**
   * H2 refill: hand a workspace that was started bare its goal now. Rejects
   * readably when the run already has one (steer it with a message instead) or
   * when its CLI refused the text.
   */
  assignWorkspaceGoal: (workspaceId: string, goal: string): Promise<void> =>
    ipcRenderer.invoke(APP.workspacesGoal, { workspaceId, goal }),
  /** E3: start a workspace briefed on the profile's newest journaled run. */
  resumeWorkspace: (profileId: string): Promise<void> =>
    ipcRenderer.invoke(APP.workspacesResume, { profileId }),
  /** Panel-only: type text into the orchestrator's terminal (voice control). */
  sendToOrchestrator: (workspaceId: string, text: string): Promise<void> =>
    ipcRenderer.invoke(APP.workspacesSendToOrchestrator, { workspaceId, text }),
  stopWorkspace: (workspaceId: string): Promise<void> =>
    ipcRenderer.invoke(APP.workspacesStop, { workspaceId }),
  /**
   * C6/S3: replace this workspace's orchestrator with a fresh one that
   * continues the run — the escape hatch for a dead or silent orchestrator.
   * Subagents, worktrees and the task board stay; rejects readably when there
   * is nothing to replace.
   */
  succeedOrchestrator: (workspaceId: string): Promise<void> =>
    ipcRenderer.invoke(APP.workspacesSucceedOrchestrator, { workspaceId }),
  focusAgent: (agentId: string): Promise<void> =>
    ipcRenderer.invoke(APP.workspacesFocusAgent, { agentId }),
  /**
   * Close one agent's CLI window. The agent stays listed — a finished worker
   * can leave the screen without forgetting what it worked on.
   */
  closeAgentWindow: (agentId: string): Promise<void> =>
    ipcRenderer.invoke(APP.workspacesCloseAgent, { agentId }),
  focusWorkspace: (workspaceId: string): Promise<void> =>
    ipcRenderer.invoke(APP.workspacesFocus, { workspaceId }),
  /**
   * Answer an agent's open question from the panel badge — the same host path
   * the orchestrator's send_to_agent{questionId} takes. Rejects with a
   * readable message when the question is gone or delivery failed.
   */
  answerQuestion: (
    workspaceId: string,
    agentId: string,
    questionId: string,
    text: string
  ): Promise<void> =>
    ipcRenderer.invoke(APP.workspacesAnswerQuestion, { workspaceId, agentId, questionId, text }),
  /**
   * D2: steer a running workspace — the text shows up in the orchestrator's
   * terminal and wakes its parked await_events as a user_message event.
   */
  sendUserMessage: (workspaceId: string, text: string): Promise<void> =>
    ipcRenderer.invoke(APP.workspacesUserMessage, { workspaceId, text }),
  /**
   * E1 Promote — the user's explicit click: merge this agent's branch into
   * the repository's own checkout. Rejects readably on a dirty checkout or a
   * conflict (the merge is aborted then; nothing changes).
   */
  promoteAgentBranch: (workspaceId: string, agentId: string): Promise<void> =>
    ipcRenderer.invoke(APP.workspacesPromoteAgent, { workspaceId, agentId }),
  /**
   * Reveal this run's artefact folder (spill/, tasks.json, events.jsonl) in the
   * OS file manager. Rejects readably when the run left nothing on disk.
   */
  openRunFolder: (workspaceId: string): Promise<void> =>
    ipcRenderer.invoke(APP.workspacesOpenRunFolder, { workspaceId }),
  /** Stale worktrees of this profile's repo — the panel's cleanup list. */
  listStaleWorktrees: (profileId: string): Promise<StaleWorktreeSummary[]> =>
    ipcRenderer.invoke(APP.worktreesList, { profileId }),
  /**
   * Remove ONE stale worktree (explicit user click). Live agents' worktrees
   * are refused in main, dirty ones by git; branches always survive. Answers
   * with the refreshed stale list.
   */
  removeWorktree: (profileId: string, path: string): Promise<StaleWorktreeSummary[]> =>
    ipcRenderer.invoke(APP.worktreesRemove, { profileId, path }),
  /** Run retrospectives, newest first — the panel's retro view. */
  listRetros: (profileId?: string): Promise<RunRetro[]> =>
    ipcRenderer.invoke(APP.retroList, profileId ? { profileId } : {}),
  /** Model learnings; entries without profile context show for every profile. */
  listLearnings: (profileId?: string): Promise<ModelLearning[]> =>
    ipcRenderer.invoke(APP.retroLearnings, profileId ? { profileId } : {}),
  /** Remove one learning (explicit user click); answers with the refreshed list. */
  deleteLearning: (id: string): Promise<ModelLearning[]> =>
    ipcRenderer.invoke(APP.retroDeleteLearning, { id }),
  /** E2: repo notes recorded by past runs; the briefing feeds on them. */
  listRepoNotes: (profileId?: string): Promise<RepoNote[]> =>
    ipcRenderer.invoke(APP.retroRepoNotes, profileId ? { profileId } : {}),
  /** Remove one repo note (explicit user click); answers with the refreshed list. */
  deleteRepoNote: (id: string): Promise<RepoNote[]> =>
    ipcRenderer.invoke(APP.retroDeleteRepoNote, { id }),
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
   * Minimize the panel itself. Hide-all leaves the panel standing by design, so
   * this is the only way to put it away; the taskbar entry brings it back.
   */
  minimizePanel: (): Promise<void> => ipcRenderer.invoke(APP.windowsMinimizePanel),
  /**
   * Quit Vertragus. Resolves false when running agents made main ask and the
   * user cancelled; true means the shutdown is under way.
   */
  quitApp: (): Promise<boolean> => ipcRenderer.invoke(APP.appQuit),
  pickDirectory: (defaultPath?: string): Promise<string | null> =>
    ipcRenderer.invoke(APP.dialogPickDirectory, { defaultPath }),
  /**
   * Open the profile editor. `providerId` (WP-7) preselects the orchestrator
   * of a NEW profile and is ignored for an existing one — a hint from the
   * first-run card, never a write.
   */
  openProfileEditor: (profileId?: string, providerId?: string): Promise<void> =>
    ipcRenderer.invoke(APP.profileEditorOpen, { profileId, providerId }),
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
    subscribe(PANEL_POINTER, listener),
  voiceStatus: (): Promise<VoiceStatusPayload> => ipcRenderer.invoke(APP.voiceStatus),
  setVoiceEnabled: (enabled: boolean): Promise<VoiceStatusPayload> =>
    ipcRenderer.invoke(APP.voiceSetEnabled, { enabled }),
  sendVoicePcm: (pcm: Int16Array): void => {
    ipcRenderer.send(APP.voicePcm, pcm)
  },
  onVoice: (listener: (event: VoiceEventPayload) => void): (() => void) =>
    subscribe(APP.eventVoice, listener),
  onVoiceAudio: (listener: (pcm: Int16Array) => void): (() => void) =>
    subscribe(APP.voiceAudio, listener),

  // --- remote access (settings window only, enforced in main) ---
  /** Current remote-server status: enabled, running, bind address, pairing URL. */
  getRemote: (): Promise<RemoteStatus> => ipcRenderer.invoke(APP.remoteGet),
  /** Toggle/reconfigure remote access; answers with the fresh status. */
  setRemote: (patch: {
    enabled?: boolean
    bindAddress?: string
    port?: number
  }): Promise<RemoteStatus> => ipcRenderer.invoke(APP.remoteSet, patch),
  /** New pairing token — every existing session dies and the QR changes. */
  regenerateRemoteToken: (): Promise<RemoteStatus> =>
    ipcRenderer.invoke(APP.remoteRegenerateToken),
  /** The paired clients currently connected. */
  listRemoteClients: (): Promise<RemoteClientInfo[]> => ipcRenderer.invoke(APP.remoteClients),
  /** Kick one client by its session token. */
  revokeRemoteClient: (token: string): Promise<boolean> =>
    ipcRenderer.invoke(APP.remoteRevokeClient, token),
  /** The bind-address options the picker offers (Tailscale first). */
  listRemoteInterfaces: (): Promise<BindOption[]> => ipcRenderer.invoke(APP.remoteInterfaces),
  /** Remote status changed — a client connected, the server started/stopped. */
  onRemote: (listener: (status: RemoteStatus) => void): (() => void) =>
    subscribe(APP.eventRemote, listener)
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
   * whole multi-monitor layout and not just its own screen. Drafts store
   * rectangles only — `reflowNeighbors` is overlay-local until save.
   */
  draft: (payload: { zones: readonly Zone[] }): void => {
    ipcRenderer.send(APP.zonesDraft, payload)
  },
  /** Persist the layout of every overlay and close the session. */
  save: (
    profileId: string,
    payload: { zones: readonly Zone[]; reflowNeighbors?: boolean }
  ): Promise<ZoneLayout> => ipcRenderer.invoke(APP.zonesSave, { profileId, ...payload }),
  /** Esc: close every overlay, save nothing. */
  cancel: (): void => {
    ipcRenderer.send(APP.zonesCancel)
  },
  /**
   * Multi-monitor picker: pin Vertragus to this display, move the overlay
   * onto it, and return the editor payload for that screen.
   */
  pickDisplay: (displayId: number): Promise<ZoneEditorPayload> =>
    ipcRenderer.invoke(APP.zonesPickDisplay, { displayId })
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
