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
 *
 * The `… rejected — <reason>` throws in this file are RAW ENGLISH ON PURPOSE
 * and must not be moved into `mainMessages`. Every one of them is a payload or
 * sender assertion — a missing id, a wrong window type, a malformed zone list —
 * that no button press can produce; reaching one means the renderer or the
 * preload contract is broken, and the reader is whoever debugs that. Localized
 * copy here would only make a bug report harder to search for. Anything a
 * correct renderer CAN provoke belongs in the locale table like everything
 * else — see the stub refusal below.
 */
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { profileRoleIds, type Profile, type RoleTemplate } from '@shared/schema/profile'
import {
  PROFILE_BUNDLE_MAX_BYTES,
  ensureJsonExtension,
  importProfileFromBundle,
  packProfileBundle,
  parseProfileBundleText,
  serializeProfileBundle,
  suggestedProfileFilename
} from '@shared/schema/profileBundle'
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
import {
  extraMcpServerSchema,
  isReservedMcpServerId,
  MAX_EXTRA_MCP_SERVERS,
  normalizeMcpServerId,
  type ExtraMcpServer
} from '@shared/schema/mcpServer'
import type { ProviderConfig } from '@shared/schema/provider'
import { normalizeAppearance, type Appearance } from '@shared/appearance'
import { DEFAULT_CLI_SURFACE, isCliSurface, type CliSurface } from '@shared/cliSurface'
import { mainMessages, readLocale } from '@shared/mainMessages'
import type { AppSettings, SettingsStore, VoiceSettings } from '@main/store/settings'
import { effectiveAgentPolicy, settings } from '@main/store/settings'
import type { AgentPolicy } from '@shared/agentPolicy'
import { AGENT_POLICIES } from '@shared/agentPolicy'
import type { VoicePhase } from '@main/voice/session'
import { asInt16Pcm } from '@main/voice/pcm'
import { discoverModels, type ModelDiscoveryResult } from '@main/providers/discovery'
import { checkAllProviderAuth, type ProviderAuthStatus } from '@main/providers/authStatus'
import { checkAllProviders, type ProviderHealth } from '@main/providers/health'
import { closeCliWindow, focusCliWindow, listCliWindows } from '@main/windows/cliWindow'
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
  listZoneDisplays,
  listZoneOverlayWindows,
  openZoneOverlayWindows,
  selectZoneOverlayDisplay,
  zoneOverlayDisplayIds,
  type ZoneDisplayInfo,
  type ZoneOverlaySender
} from '@main/windows/zoneOverlay'
import type { MinimalIpcMain } from './ipc'
import { listRuns, readRun } from '@main/workspace/listRuns'

export const APP_CHANNELS = {
  profilesList: 'profiles:list',
  profilesSave: 'profiles:save',
  profilesDelete: 'profiles:delete',
  /**
   * Write one stored profile to a JSON file the user picks (no zones).
   * Import is the inverse — a new profile, never an overwrite.
   */
  profilesExport: 'profiles:export',
  profilesImport: 'profiles:import',
  rolesList: 'roles:list',
  rolesSave: 'roles:save',
  providersList: 'providers:list',
  /**
   * WP-7: login state per provider, read on demand by the panel's first-run
   * card. Separate from `providers:list` because it is a different kind of
   * cost — `list` probes `--version` on every editor open, this one shells out
   * to the CLIs' own status commands and is only ever run while somebody is
   * looking at the answer.
   */
  providersAuthStatus: 'providers:authStatus',
  providersSave: 'providers:save',
  providersDelete: 'providers:delete',
  modelsDiscover: 'models:discover',
  workspacesList: 'workspaces:list',
  workspacesStart: 'workspaces:start',
  /**
   * H2 refill: hand a run that was started bare its goal now. Separate from
   * `workspaces:userMessage` on purpose — a goal is the orchestrator's FIRST
   * user turn (it starts the loop), a user message steers a loop that runs.
   */
  workspacesGoal: 'workspaces:goal',
  workspacesResume: 'workspaces:resume',
  workspacesSendToOrchestrator: 'workspaces:sendToOrchestrator',
  workspacesStop: 'workspaces:stop',
  workspacesSucceedOrchestrator: 'workspaces:succeedOrchestrator',
  workspacesFocusAgent: 'workspaces:focusAgent',
  workspacesFocus: 'workspaces:focus',
  workspacesCloseAgent: 'workspaces:closeAgent',
  workspacesAnswerQuestion: 'workspaces:answerQuestion',
  workspacesUserMessage: 'workspaces:userMessage',
  workspacesPromoteAgent: 'workspaces:promoteAgent',
  /**
   * S1/S4: reveal one run's artefact folder (`spill/`, `tasks.json`,
   * `events.jsonl`) in the OS file manager. Panel-only and deliberately absent
   * from the remote gateway — opening a folder is meaningful on the machine
   * the app runs on and nowhere else.
   */
  workspacesOpenRunFolder: 'workspaces:openRunFolder',
  worktreesList: 'worktrees:list',
  worktreesRemove: 'worktrees:remove',
  retroList: 'retro:list',
  retroLearnings: 'retro:learnings',
  retroDeleteLearning: 'retro:deleteLearning',
  retroRepoNotes: 'retro:repoNotes',
  retroDeleteRepoNote: 'retro:deleteRepoNote',
  /**
   * Archive of this profile's journals (live + stopped). Panel-only; the
   * timeline is a read of files the host already writes.
   */
  runsList: 'runs:list',
  runsGet: 'runs:get',
  settingsGet: 'settings:get',
  settingsYolo: 'settings:yolo',
  settingsSet: 'settings:set',
  windowsHideAll: 'windows:hideAll',
  windowsMinimizePanel: 'windows:minimizePanel',
  appQuit: 'app:quit',
  /**
   * Voice is panel-only: the strip owns the mic, and a CLI window that could
   * push PCM or flip the session would be a way to listen in from a foreign
   * renderer. Status/setEnabled are invokes; pcm is a send (audio is hot);
   * ev:voice and voice:audio are main → panel pushes.
   */
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
  /**
   * App settings changed — the whole {@link PanelSettings} object, pushed to
   * every app window. The renderer's i18n follows it: the language picker sits
   * in the settings window, but the panel and both editors have to change with
   * it, and asking each of them to poll `settings:get` would make "switch the
   * language" a race against the poll interval.
   */
  eventSettings: 'ev:settings',
  eventVoice: 'ev:voice',
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
  /**
   * Current task for the row's hover card. Subagents: last `start_agent` /
   * follow-up `send_to_agent`. Orchestrator: latest submitted user CLI note.
   */
  taskText?: string
  /**
   * True while this agent's CLI window is on screen. A finished agent whose
   * window is still open can be dismissed with ✕; a closed one stays listed
   * so the last task remains readable, and a click reopens the scrollback.
   */
  windowOpen?: boolean
  /**
   * F: 'orchestrator' for the root row, 'lead' for sub-orchestrators, the
   * role id otherwise. Drives the panel's indentation and lead styling.
   */
  kind?: string
  /** F: the lead this agent works under; absent for direct children. */
  parentId?: string
  /** Set while the agent waits for an answer — drives the `?` badge. */
  pendingQuestion?: string
  /**
   * Registry id of that open question — what the badge's answer field sends
   * back over `workspaces:answerQuestion`. Always set together with
   * {@link pendingQuestion}.
   */
  pendingQuestionId?: string
}

/**
 * S4: one row of the run's task board, as the card paints it. Mirrors
 * `Workspace.listTasks()`; see {@link PANEL_TASKS_MAX} for why the card only
 * ever sees a prefix of the board.
 */
export interface WorkspaceTaskSummary {
  taskId: string
  subject: string
  /** Tombstones never travel — the summary carries the living plan only. */
  status: 'pending' | 'in_progress' | 'completed'
  /** Agent id of the owner; resolved to its Commedia name from `agents`. */
  ownerAgentId?: string
  blockedBy: string[]
  /** pending AND every blockedBy completed — the board's own readiness rule. */
  ready: boolean
}

/**
 * How many board rows one card carries. The board itself allows 200; this
 * payload is re-broadcast on every change and travels to the phone as well, so
 * it stays a bounded prefix. The whole board remains readable in `tasks.json`
 * and through the orchestrator's `task_list`.
 */
export const PANEL_TASKS_MAX = 30

/**
 * Current-task fields the panel paints on an agent row and its hover card.
 * One note fills both so the status line and the lore card cannot disagree.
 */
export function agentCurrentTaskFields(
  task: string | undefined
): Pick<WorkspaceAgentSummary, 'taskText' | 'statusText'> {
  if (!task?.trim()) return {}
  return { taskText: task, statusText: task }
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
  /**
   * Last delegated assignment, when still populated. The workspace hover uses
   * {@link goalText}, not this.
   */
  taskText?: string
  /**
   * The user's workspace goal — first submitted orchestrator CLI note, or the
   * start-with-goal once delivered. Full text; the hover card quotes it.
   * Absent on a bare Play: the card then shows "no goal — the orchestrator
   * is waiting".
   */
  goalText?: string
  /**
   * C5: the orchestrator process lives but has stopped calling its tools —
   * the card shows an idle hint distinct from the greyed-out exited state.
   */
  orchestratorIdle?: boolean
  /**
   * C6: a successor orchestrator is being spawned for this workspace. The card
   * shows a badge — mid-cutover is neither the working state nor the dead one,
   * and the replace button must not be offered twice.
   */
  successionInProgress?: true
  /**
   * D3: the orchestrator's open `ask_user` question — the workspace-level
   * badge. Answered over the same `workspaces:answerQuestion` channel with
   * the reserved agent id `user`.
   */
  userQuestion?: { questionId: string; question: string }
  agents: WorkspaceAgentSummary[]
  /**
   * S4: the run's task board, capped at {@link PANEL_TASKS_MAX} and free of
   * tombstones. Absent while the run has no plan — an empty board draws no
   * section at all.
   */
  tasks?: WorkspaceTaskSummary[]
  /**
   * S4: rows in the WHOLE living plan, and how many of them are completed —
   * counts over the board, not over {@link tasks}. The window is a display
   * decision; "30/45 done" is a fact about the run, and a card that recomputed
   * it from the rows that happened to fit would read an unfinished plan as
   * finished. Present exactly when {@link tasks} is.
   */
  taskTotal?: number
  taskDone?: number
  /**
   * A3: the run's pull request, once `automation.autoPr` has run. `ok: false`
   * still travels — the card then shows why there is none, and `url` is the
   * compare link when the branch did reach the remote.
   */
  pullRequest?: { ok: boolean; url?: string; message?: string }
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
   * own runtime object needs no adapter lambda here. `goal` (H2) is seeded
   * into the orchestrator once it is up; absent = classic bare Play.
   */
  start(profileId: string, goal?: string): void | Promise<unknown>
  /**
   * H2 refill: the goal for a run that was started without one. Rejects with a
   * readable message when the workspace is unknown, already carries a goal, or
   * its CLI refused the text — the run keeps going in every case.
   */
  assignGoal(workspaceId: string, goal: string): Promise<void>
  /**
   * E3: start a NEW workspace of this profile briefed on the repository's
   * newest journaled run (worktrees/branches survive; processes do not).
   * Rejects with a readable message when the repo holds no journaled run.
   */
  resume(profileId: string): void | Promise<unknown>
  stop(workspaceId: string): void | Promise<unknown>
  /**
   * C6/S3: replace this workspace's root orchestrator with a fresh one that
   * continues the same run — the user's escape hatch when the orchestrator
   * died or went silent. Keeps subagents, worktrees, questions and the task
   * board; rejects with a readable message when there is nothing to replace.
   */
  succeedOrchestrator(workspaceId: string): void | Promise<unknown>
  /**
   * Answer one agent question (H1) — the SAME host path the orchestrator's
   * `send_to_agent{questionId}` takes, so panel, remote and MCP tool share one
   * question registry. Rejects with a readable message on failure (unknown
   * question, wrong agent, PTY delivery failed — the question stays open then).
   */
  answerQuestion(
    workspaceId: string,
    agentId: string,
    questionId: string,
    text: string
  ): Promise<void>
  /**
   * D2: steer the run — the text appears in the orchestrator's terminal and
   * lands as a `user_message` event that wakes its parked `await_events`.
   * `targetAgentId` is an optional addressee among the team; the host still
   * delivers on the root queue (no peer-to-peer).
   */
  postUserMessage(
    workspaceId: string,
    text: string,
    targetAgentId?: string
  ): void | Promise<unknown>
  /**
   * E1 Promote — the user's explicit click: merge this agent's branch into
   * the repository's own checkout. Must reject with a readable message on a
   * dirty main checkout or a merge conflict (the merge is aborted then).
   */
  promoteAgentBranch(workspaceId: string, agentId: string): Promise<void>
  /**
   * Reveal this run's artefact folder in the OS file manager — the journal,
   * the task board and the spill files the tools wrote. Rejects readably when
   * the workspace is unknown or the OS refused to open the path.
   */
  openRunFolder(workspaceId: string): Promise<void>
  /** Panel-only: type a follow-up into the running orchestrator (voice). */
  sendToOrchestrator(workspaceId: string, text: string): void | Promise<unknown>
  /** Bring an agent's CLI window to the front. */
  focusAgent(agentId: string): void
  /**
   * Close one agent's CLI window. The agent (and its last task) stay listed —
   * a finished worker that occupied the screen can be dismissed without
   * forgetting what it did.
   */
  closeAgentWindow(agentId: string): void
  /**
   * Bring one workspace's CLI windows forward into its zone layout and hide
   * every other agent's — see {@link focusWorkspaceAgents}.
   */
  focusWorkspace(workspaceId: string): void
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
 * and `focusAgent` still works (the CLI window registry exists), but `start`,
 * `stop` and `sendToOrchestrator` REFUSE loudly: a Play button that quietly
 * does nothing is the worst possible placeholder.
 *
 * `bootError` is what the app entry caught when the MCP server failed to
 * start. Carried into the refusal because the panel is the only surface the
 * user has: without it every workspace channel blames an unfinished feature
 * while the actual cause reaches nothing but `console.error`.
 */
export function createStubWorkspaceDirectory(
  locale: () => string | undefined = () => undefined,
  bootError?: string
): WorkspaceDirectory {
  const refuse = (): never => {
    const messages = mainMessages(readLocale(locale))
    throw new Error(bootError ? messages.stubBootFailed(bootError) : messages.stubNotWired)
  }
  return {
    list: () => [],
    start: refuse,
    assignGoal: async () => refuse(),
    resume: refuse,
    stop: refuse,
    succeedOrchestrator: refuse,
    answerQuestion: async () => refuse(),
    postUserMessage: refuse,
    promoteAgentBranch: async () => refuse(),
    openRunFolder: async () => refuse(),
    sendToOrchestrator: refuse,
    focusAgent: (agentId) => focusCliWindow(agentId),
    closeAgentWindow: (agentId) => closeCliWindow(agentId),
    // No manager → no workspace→agent map; quiet no-op like focusAgent on a ghost.
    focusWorkspace() {},
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
  | 'getRunRetros'
  | 'getModelLearnings'
  | 'deleteModelLearning'
  | 'getRepoNotes'
  | 'deleteRepoNote'
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
  /** D4: the effective tier — stored policy, or derived from `yoloMaster`. */
  agentPolicy: AgentPolicy
  /**
   * Spawn overlay: run agent processes through Pi. Not a seventh provider —
   * the roster still names Claude / Cursor / Codex / Kimi / Grok / Ollama.
   */
  piHarnessEnabled: boolean
  hideAllHotkey: string
  locale: AppSettings['ui']['locale']
  theme: AppSettings['ui']['theme']
  /** Opacity and glass transparency; see shared/appearance.ts. */
  appearance: Appearance
  /**
   * How CLI windows paint: host session chrome (same view for every provider)
   * or the vendor TUI.
   */
  cliSurface: CliSurface
  /** When a window or zone is moved, neighbors shrink and fill the gap. */
  reflowNeighbors: boolean
  /** WP-7: the first-run card was closed by hand — the panel honours it. */
  onboardingDismissed: boolean
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
  /** Voice assistant master switch. Off by default. */
  voiceEnabled: boolean
  voiceWakePhrase: string
  voiceVoiceId: string
  voiceProvider: VoiceSettings['provider']
  /**
   * Whether an xAI key is stored. The raw key never rides on this object or on
   * `ev:settings` — a renderer that displayed it would leak it into logs.
   */
  voiceApiKeySet: boolean
  /** Whether an OpenAI key is stored. The raw key never appears here. */
  voiceOpenaiApiKeySet: boolean
  voiceInputDeviceId: string
  voiceOutputDeviceId: string
  /**
   * Extra MCP servers with secrets stripped. Env/header VALUES never appear
   * here — only keys and a per-key `set` flag, like voice API keys.
   */
  mcpServers: PanelMcpServer[]
}

/**
 * One extra MCP server as the settings window sees it. Command, args and url
 * may appear — they identify the server. Secrets do not.
 */
export interface PanelMcpServer {
  id: string
  label: string
  enabled: boolean
  transport: ExtraMcpServer['transport']
  command?: string
  args?: string[]
  url?: string
  envKeys: string[]
  headerKeys: string[]
  envSet: Record<string, boolean>
  headersSet: Record<string, boolean>
}

export type { VoicePhase }

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

/**
 * Production session lives in `appVoice.ts` / `index.ts`, not inside the
 * sockets here. Tests inject a fake; production injects the real host.
 */
export interface AppVoicePort {
  status(): VoiceStatusPayload
  setEnabled(on: boolean): Promise<unknown> | unknown
  pushPcm(pcm: Int16Array): void
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
  'appearance',
  'cliSurface',
  'reflowNeighbors',
  'voice',
  'agentPolicy',
  'piHarnessEnabled',
  'onboardingDismissed',
  'mcpServers'
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
  /** Only the zones of THIS display. */
  zones: Zone[]
  /**
   * Attached monitors — the picker lists them so the user can choose a
   * screen even when the overlay itself could not be placed on it.
   */
  displays: ZoneDisplayInfo[]
  /** True while this overlay is asking which screen Vertragus should use. */
  selectingDisplay: boolean
  /**
   * UI language / appearance for this overlay. Added by the `zones:load`
   * handler, not by {@link zoneEditorPayload} — an overlay cannot call
   * `settings:get`, so the one payload it does receive is where they travel.
   */
  locale?: AppSettings['ui']['locale']
  theme?: AppSettings['ui']['theme']
  /** Same constraint as locale — overlays cannot call `settings:get`. */
  reflowNeighbors?: boolean
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
  displayId: number,
  displays: readonly ZoneDisplayInfo[] = [],
  selectingDisplay = false
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
    zones: (profile.zones?.zones ?? []).filter((zone) => zone.displayId === displayId),
    displays: [...displays],
    selectingDisplay
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
  coveredDisplayIds: readonly number[],
  targetDisplayId?: number
): ZoneLayout {
  const covered = new Set([...coveredDisplayIds, ...drafts.keys()])
  const kept = (existing?.zones ?? []).filter((zone) => !covered.has(zone.displayId))
  // By display id, not by the order the overlays happened to report in — the
  // stored layout should not depend on which monitor the user dragged first.
  const drawn = [...drafts.entries()]
    .sort(([left], [right]) => left - right)
    .flatMap(([, zones]) => zones)
  const target =
    targetDisplayId ??
    (coveredDisplayIds.length === 1 ? coveredDisplayIds[0] : existing?.targetDisplayId)
  return zoneLayoutSchema.parse({
    zones: [...kept, ...drawn],
    ...(target !== undefined ? { targetDisplayId: target } : {})
  })
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
export function quitConfirmationText(
  runningAgents: number,
  locale?: string
): {
  title: string
  message: string
  detail: string
  confirm: string
  cancel: string
} {
  const messages = mainMessages(locale)
  return {
    title: messages.quitTitle,
    message: messages.quitMessage(runningAgents),
    detail: messages.quitDetail,
    confirm: messages.quitConfirm,
    cancel: messages.quitCancel
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
  /** WP-7: login state per provider; see `@main/providers/authStatus`. */
  checkProviderAuth(configs: readonly ProviderConfig[]): Promise<ProviderAuthStatus[]>
  pickDirectory(webContentsId: number, defaultPath?: string): Promise<string | null>
  /**
   * Native save dialog for a profile export. `defaultPath` is a filename
   * suggestion, not a directory. Null when the user cancelled.
   */
  pickSaveFile(
    webContentsId: number,
    options: { defaultPath: string; title: string; filterName: string }
  ): Promise<string | null>
  /** Native open dialog for a profile import. Null when cancelled. */
  pickOpenFile(
    webContentsId: number,
    options: { title: string; filterName: string }
  ): Promise<string | null>
  writeTextFile(path: string, text: string): void
  readTextFile(path: string): string
  /** Byte length on disk, used to refuse a dump before reading it. */
  fileSize(path: string): number
  /**
   * `providerId` (WP-7) preselects the orchestrator of a NEW profile — the
   * first-run card knows which CLI actually answered its health probe, and
   * dropping the user into a form defaulted to a provider that is not
   * installed is how a guided first run stops being guided. A hint, never a
   * write: an existing profile carries its own provider and ignores it.
   */
  openProfileEditor(profileId?: string, providerId?: string): void
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
  /** Open the zone overlay for this profile (picker when several monitors). */
  openZoneOverlays(profileId: string): void
  closeZoneOverlays(): void
  /**
   * Bind the live overlay to this display and leave picker mode. Optional so
   * a test host that never opens overlays does not have to stub it.
   */
  selectZoneOverlayDisplay?(displayId: number): boolean
  /** Attached monitors as the picker labels them. */
  listZoneDisplays?(): ZoneDisplayInfo[]
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
  /**
   * Optional so `createAppIpc` stays testable without a realtime socket.
   * Production wires this in `index.ts` after the WorkspaceDirectory exists.
   */
  voice?: AppVoicePort
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
    agentPolicy: effectiveAgentPolicy(value),
    piHarnessEnabled: value.piHarnessEnabled,
    hideAllHotkey: value.hideAllHotkey,
    locale: value.ui.locale,
    theme: value.ui.theme,
    appearance: value.ui.appearance,
    cliSurface: value.ui.cliSurface ?? DEFAULT_CLI_SURFACE,
    reflowNeighbors: value.ui.reflowNeighbors,
    onboardingDismissed: value.ui.onboardingDismissed,
    autostart: value.autostart,
    updateChannel: value.updateChannel,
    autostartSupported,
    voiceEnabled: value.voice.enabled,
    voiceWakePhrase: value.voice.wakePhrase,
    voiceVoiceId: value.voice.voiceId,
    voiceProvider: value.voice.provider,
    voiceApiKeySet: value.voice.apiKey.trim().length > 0,
    voiceOpenaiApiKeySet: value.voice.openaiApiKey.trim().length > 0,
    voiceInputDeviceId: value.voice.inputDeviceId,
    voiceOutputDeviceId: value.voice.outputDeviceId,
    mcpServers: value.mcpServers.map(toPanelMcpServer),
    ...(hotkey && !hotkey.registered ? { hideAllHotkeyError: hotkey.error ?? '' } : {})
  }
}

function secretSetFlags(record: Record<string, string> | undefined): {
  keys: string[]
  set: Record<string, boolean>
} {
  const keys = record ? Object.keys(record) : []
  const set: Record<string, boolean> = {}
  for (const key of keys) set[key] = (record?.[key] ?? '').length > 0
  return { keys, set }
}

/** Strip env/header values. Command, args and url may appear — they identify the server. */
export function toPanelMcpServer(server: ExtraMcpServer): PanelMcpServer {
  if (server.transport === 'stdio') {
    const env = secretSetFlags(server.env)
    return {
      id: server.id,
      label: server.label,
      enabled: server.enabled,
      transport: 'stdio',
      command: server.command,
      ...(server.args.length > 0 ? { args: server.args } : {}),
      envKeys: env.keys,
      headerKeys: [],
      envSet: env.set,
      headersSet: {}
    }
  }
  const headers = secretSetFlags(server.headers)
  return {
    id: server.id,
    label: server.label,
    enabled: server.enabled,
    transport: 'http',
    url: server.url,
    envKeys: [],
    headerKeys: headers.keys,
    envSet: {},
    headersSet: headers.set
  }
}

/**
 * Patch the stored extra-MCP list. The patch is the full list (add/remove/reorder).
 * Servers not in the patch are deleted. Per server, match by id. For env/headers:
 * keys present with a non-empty value replace; keys present with `''` keep the
 * stored value (the renderer cannot see it); keys omitted from the patch object
 * are deleted. Omitting `env`/`headers` entirely keeps the stored record.
 *
 * Id rename: if exactly one patch row of a transport has an unknown id AND
 * exactly one stored server of that transport is absent from the patch, that
 * leftover's env/headers are used as `stored`. Two new ids of the same
 * transport do not inherit one leftover secret. Key rename: if exactly one
 * stored key is missing from the patch and exactly one patch key is new with
 * an empty value, the leftover value is copied onto the new key.
 */
export function mergeMcpServersPatch(current: ExtraMcpServer[], patch: unknown): ExtraMcpServer[] {
  if (!Array.isArray(patch)) {
    throw new Error('settings:set rejected — mcpServers expects an array')
  }
  if (patch.length > MAX_EXTRA_MCP_SERVERS) {
    throw new Error(`settings:set rejected — at most ${MAX_EXTRA_MCP_SERVERS} MCP servers`)
  }
  const storedById = new Map(current.map((server) => [server.id, server]))
  const seen = new Set<string>()
  const bodies: { id: string; body: Record<string, unknown> }[] = []
  for (const entry of patch) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('settings:set rejected — each mcp server must be an object')
    }
    const body = entry as Record<string, unknown>
    const rawId = typeof body.id === 'string' ? body.id : ''
    const id = normalizeMcpServerId(rawId)
    if (!id) {
      throw new Error('settings:set rejected — mcp server id is required')
    }
    if (isReservedMcpServerId(id) || isReservedMcpServerId(rawId)) {
      throw new Error('settings:set rejected — mcp server id "vertragus" is reserved')
    }
    if (seen.has(id)) {
      throw new Error(`settings:set rejected — duplicate mcp server id "${id}"`)
    }
    seen.add(id)
    bodies.push({ id, body })
  }
  const leftoverByTransport = leftoverByTransportMap(current, storedById, seen, bodies)
  const merged: ExtraMcpServer[] = []
  for (const { id, body } of bodies) {
    const stored =
      storedById.get(id) ??
      (body.transport === 'stdio' || body.transport === 'http'
        ? leftoverByTransport.get(body.transport)
        : undefined)
    if (body.transport === 'stdio') {
      const env = mergeSecretRecord(stored?.transport === 'stdio' ? stored.env : undefined, body.env)
      merged.push(
        extraMcpServerSchema.parse({
          id,
          label: body.label ?? stored?.label,
          enabled: body.enabled ?? stored?.enabled,
          transport: 'stdio',
          command: body.command,
          args: body.args,
          ...(env ? { env } : {})
        })
      )
    } else if (body.transport === 'http') {
      const headers = mergeSecretRecord(
        stored?.transport === 'http' ? stored.headers : undefined,
        body.headers
      )
      merged.push(
        extraMcpServerSchema.parse({
          id,
          label: body.label ?? stored?.label,
          enabled: body.enabled ?? stored?.enabled,
          transport: 'http',
          url: body.url,
          ...(headers ? { headers } : {})
        })
      )
    } else {
      throw new Error('settings:set rejected — mcp server transport expects stdio or http')
    }
  }
  return merged
}

/**
 * A leftover is only a rename when the mapping is 1:1 per transport: exactly
 * one stored server of that transport is missing from the patch, and exactly
 * one patch row of that transport has an unknown id.
 */
function leftoverByTransportMap(
  current: readonly ExtraMcpServer[],
  storedById: ReadonlyMap<string, ExtraMcpServer>,
  patchIds: ReadonlySet<string>,
  bodies: readonly { id: string; body: Record<string, unknown> }[]
): Map<'stdio' | 'http', ExtraMcpServer> {
  const leftovers = new Map<'stdio' | 'http', ExtraMcpServer>()
  for (const transport of ['stdio', 'http'] as const) {
    const unused = current.filter(
      (server) => !patchIds.has(server.id) && server.transport === transport
    )
    const newcomers = bodies.filter(
      (entry) => !storedById.has(entry.id) && entry.body.transport === transport
    )
    if (unused.length === 1 && newcomers.length === 1) {
      leftovers.set(transport, unused[0]!)
    }
  }
  return leftovers
}

function mergeSecretRecord(
  stored: Record<string, string> | undefined,
  patch: unknown
): Record<string, string> | undefined {
  if (patch === undefined) return stored
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('settings:set rejected — mcpServers env/headers expects an object')
  }
  const body = patch as Record<string, unknown>
  const source = renamedSecretRecord(stored, body)
  const next: Record<string, string> = {}
  for (const [key, value] of Object.entries(body)) {
    if (typeof value !== 'string') {
      throw new Error(`settings:set rejected — mcpServers env/headers.${key} expects a string`)
    }
    if (value.length > 0) {
      next[key] = value
      continue
    }
    const kept = source[key]
    if (kept !== undefined) next[key] = kept
  }
  return Object.keys(next).length > 0 ? next : undefined
}

/**
 * If the patch dropped exactly one stored key and added exactly one new key
 * with an empty value, treat that as a rename and copy the leftover value.
 */
function renamedSecretRecord(
  stored: Record<string, string> | undefined,
  patch: Record<string, unknown>
): Record<string, string> {
  const source: Record<string, string> = { ...(stored ?? {}) }
  if (!stored) return source
  const missing = Object.keys(stored).filter((key) => !(key in patch))
  const newEmpty = Object.keys(patch).filter((key) => !(key in stored) && patch[key] === '')
  if (missing.length === 1 && newEmpty.length === 1) {
    const from = missing[0]!
    const to = newEmpty[0]!
    source[to] = stored[from]!
  }
  return source
}

/**
 * Patch the stored voice section. An empty `apiKey` / `openaiApiKey` string
 * means "leave the key the user cannot see".
 */
export function mergeVoicePatch(current: VoiceSettings, patch: unknown): VoiceSettings {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('settings:set rejected — voice expects an object')
  }
  const body = patch as Record<string, unknown>
  const next: VoiceSettings = { ...current }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') {
      throw new Error('settings:set rejected — voice.enabled expects a boolean')
    }
    next.enabled = body.enabled
  }
  if (body.wakePhrase !== undefined) {
    if (typeof body.wakePhrase !== 'string') {
      throw new Error('settings:set rejected — voice.wakePhrase expects a string')
    }
    next.wakePhrase = body.wakePhrase
  }
  if (body.voiceId !== undefined) {
    if (typeof body.voiceId !== 'string') {
      throw new Error('settings:set rejected — voice.voiceId expects a string')
    }
    next.voiceId = body.voiceId
  }
  if (body.provider !== undefined) {
    if (body.provider !== 'xai' && body.provider !== 'openai') {
      throw new Error('settings:set rejected — voice.provider expects xai or openai')
    }
    next.provider = body.provider
  }
  if (body.inputDeviceId !== undefined) {
    if (typeof body.inputDeviceId !== 'string') {
      throw new Error('settings:set rejected — voice.inputDeviceId expects a string')
    }
    next.inputDeviceId = body.inputDeviceId
  }
  if (body.outputDeviceId !== undefined) {
    if (typeof body.outputDeviceId !== 'string') {
      throw new Error('settings:set rejected — voice.outputDeviceId expects a string')
    }
    next.outputDeviceId = body.outputDeviceId
  }
  if (typeof body.apiKey === 'string' && body.apiKey.length > 0) {
    next.apiKey = body.apiKey
  }
  if (typeof body.openaiApiKey === 'string' && body.openaiApiKey.length > 0) {
    next.openaiApiKey = body.openaiApiKey
  }
  return next
}

export { asInt16Pcm }

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

  /** Overlay save may carry the toggle; only a real boolean is stored. Drafts never write it. */
  const persistReflowNeighbors = (payload: unknown): void => {
    if (typeof payload !== 'object' || payload === null) return
    if (!('reflowNeighbors' in payload)) return
    const flag = payload.reflowNeighbors
    if (typeof flag !== 'boolean') return
    const current = host.store.getSettings().ui
    if (current.reflowNeighbors === flag) return
    emitSettings(panelSettings(host.store.setSetting('ui', { ...current, reflowNeighbors: flag })))
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

  const localeMessages = (): ReturnType<typeof mainMessages> =>
    mainMessages(readLocale(() => host.store.getSettings().ui.locale))

  const asThrownReason = (cause: unknown): string =>
    cause instanceof Error ? cause.message : String(cause)

  handle(APP_CHANNELS.profilesExport, requireAppWindow, async (event, payload) => {
    const id =
      typeof payload === 'string' ? payload : (payload as { profileId?: string } | undefined)?.profileId
    if (!id) throw new Error('profiles:export rejected — missing profile id')
    const messages = localeMessages()
    const profile = host.store.getProfiles().find((entry) => entry.id === id)
    if (!profile) throw new Error(messages.unknownProfile(id))
    const target = await host.pickSaveFile(event.sender.id, {
      defaultPath: suggestedProfileFilename(profile.name),
      title: messages.profileExportTitle,
      filterName: messages.profileFileFilter
    })
    if (!target) return null
    const path = ensureJsonExtension(target)
    try {
      host.writeTextFile(
        path,
        serializeProfileBundle(packProfileBundle(profile, host.store.getRoleTemplates()))
      )
    } catch (cause) {
      throw new Error(messages.profileExportFailed(asThrownReason(cause)))
    }
    return { path }
  })

  handle(APP_CHANNELS.profilesImport, requireAppWindow, async (event) => {
    const messages = localeMessages()
    const picked = await host.pickOpenFile(event.sender.id, {
      title: messages.profileImportTitle,
      filterName: messages.profileFileFilter
    })
    if (!picked) return null
    let bytes: number
    try {
      bytes = host.fileSize(picked)
    } catch (cause) {
      throw new Error(messages.profileImportUnreadable(asThrownReason(cause)))
    }
    if (bytes > PROFILE_BUNDLE_MAX_BYTES) throw new Error(messages.profileImportTooLarge)
    let text: string
    try {
      text = host.readTextFile(picked)
    } catch (cause) {
      throw new Error(messages.profileImportUnreadable(asThrownReason(cause)))
    }
    const parsed = parseProfileBundleText(text)
    if (!parsed.ok) throw new Error(messages.profileImportInvalid)
    const { profile, roleTemplates } = importProfileFromBundle(
      parsed.bundle,
      host.store.getProfiles(),
      host.store.getRoleTemplates(),
      { importedWord: messages.profileImportedWord }
    )
    for (const template of roleTemplates) host.store.saveRoleTemplate(template)
    const profiles = host.store.saveProfile(profile)
    emitProfiles(profiles)
    return profiles
  })

  // --- roles -------------------------------------------------------------

  handle(APP_CHANNELS.rolesList, requireAppWindow, () => host.store.getRoleTemplates())

  handle(APP_CHANNELS.rolesSave, requireAppWindow, (_event, payload) =>
    host.store.saveRoleTemplate(payload)
  )

  // --- providers & models ------------------------------------------------

  handle(APP_CHANNELS.providersList, requireAppWindow, async (_event, payload) => {
    const configs = host.store.effectiveProviders()
    // `{ refresh: true }` is the first-run card's ⟳ (WP-7). The TTL exists for
    // the picker, which reads this on every editor open; but a user who just
    // installed a CLI and pressed the one button the copy told them to press
    // would otherwise be served the same "not found" for up to 30 s — a cache
    // hit does not even refresh its own timestamp, so pressing again changes
    // nothing. An explicit gesture may therefore skip the cache and overwrite
    // it; nothing that reads on a render is allowed to pass this flag.
    const refresh = (payload as { refresh?: unknown } | undefined)?.refresh === true
    const cached = !refresh && healthCache && now() - healthCache.at <= PROVIDER_HEALTH_TTL_MS
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
   * WP-7: who is logged in where.
   *
   * Guarded like `providers:list` and not more narrowly: both reads feed the
   * same first-run card, and giving the two halves of one card two different
   * sender rules would be a trap for whoever adds the third. It answers a
   * descriptor-derived login command and whatever the CLI printed about
   * itself — no credentials, no tokens, nothing a provider list does not
   * already imply.
   *
   * Deliberately uncached: the whole point is to be re-run right after the
   * user typed the login command in their own terminal, and a TTL would make
   * "I just logged in" a wait instead of a click.
   */
  handle(APP_CHANNELS.providersAuthStatus, requireAppWindow, () =>
    host.checkProviderAuth(host.store.effectiveProviders())
  )

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
    const body =
      typeof payload === 'string'
        ? { profileId: payload }
        : ((payload ?? {}) as { profileId?: string; goal?: unknown })
    if (!body.profileId) throw new Error('workspaces:start rejected — missing profile id')
    // Goal is optional (back-compat bare Play); anything non-string or blank
    // is treated as absent rather than refused — an empty field is not an error.
    const goal = typeof body.goal === 'string' && body.goal.trim() ? body.goal.trim() : undefined
    await (goal ? host.directory.start(body.profileId, goal) : host.directory.start(body.profileId))
    emitWorkspaces()
  })

  // H2 refill: unlike the start goal above, THIS one is the whole point of the
  // call — a blank field is refused instead of quietly starting nothing.
  handle(APP_CHANNELS.workspacesGoal, requirePanel, async (_event, payload) => {
    const body = (payload ?? {}) as { workspaceId?: string; goal?: unknown }
    if (!body.workspaceId) throw new Error('workspaces:goal rejected — missing workspace id')
    const goal = typeof body.goal === 'string' ? body.goal.trim() : ''
    if (!goal) throw new Error('workspaces:goal rejected — missing goal text')
    await host.directory.assignGoal(body.workspaceId, goal)
    emitWorkspaces()
  })

  handle(APP_CHANNELS.workspacesResume, requirePanel, async (_event, payload) => {
    const profileId =
      typeof payload === 'string' ? payload : (payload as { profileId?: string })?.profileId
    if (!profileId) throw new Error('workspaces:resume rejected — missing profile id')
    await host.directory.resume(profileId)
    emitWorkspaces()
  })

  handle(APP_CHANNELS.workspacesSendToOrchestrator, requirePanel, (_event, payload) => {
    const body = (payload ?? {}) as { workspaceId?: string; text?: string }
    if (!body.workspaceId) {
      throw new Error('workspaces:sendToOrchestrator rejected — missing workspace id')
    }
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (!text) throw new Error('workspaces:sendToOrchestrator rejected — missing text')
    return host.directory.sendToOrchestrator(body.workspaceId, text)
  })

  handle(APP_CHANNELS.workspacesStop, requirePanel, async (_event, payload) => {
    const workspaceId =
      typeof payload === 'string' ? payload : (payload as { workspaceId?: string })?.workspaceId
    if (!workspaceId) throw new Error('workspaces:stop rejected — missing workspace id')
    await host.directory.stop(workspaceId)
    emitWorkspaces()
  })

  handle(APP_CHANNELS.workspacesSucceedOrchestrator, requirePanel, async (_event, payload) => {
    const workspaceId =
      typeof payload === 'string' ? payload : (payload as { workspaceId?: string })?.workspaceId
    if (!workspaceId) {
      throw new Error('workspaces:succeedOrchestrator rejected — missing workspace id')
    }
    await host.directory.succeedOrchestrator(workspaceId)
    emitWorkspaces()
  })

  handle(APP_CHANNELS.workspacesFocusAgent, requirePanel, (_event, payload) => {
    const agentId =
      typeof payload === 'string' ? payload : (payload as { agentId?: string })?.agentId
    if (!agentId) throw new Error('workspaces:focusAgent rejected — missing agent id')
    host.directory.focusAgent(agentId)
  })

  handle(APP_CHANNELS.workspacesFocus, requirePanel, (_event, payload) => {
    const workspaceId =
      typeof payload === 'string' ? payload : (payload as { workspaceId?: string })?.workspaceId
    if (!workspaceId) throw new Error('workspaces:focus rejected — missing workspace id')
    host.directory.focusWorkspace(workspaceId)
  })

  handle(APP_CHANNELS.workspacesCloseAgent, requirePanel, (_event, payload) => {
    const agentId =
      typeof payload === 'string' ? payload : (payload as { agentId?: string })?.agentId
    if (!agentId) throw new Error('workspaces:closeAgent rejected — missing agent id')
    host.directory.closeAgentWindow(agentId)
    emitWorkspaces()
  })

  handle(APP_CHANNELS.workspacesAnswerQuestion, requirePanel, async (_event, payload) => {
    const body = (payload ?? {}) as {
      workspaceId?: string
      agentId?: string
      questionId?: string
      text?: string
    }
    if (!body.workspaceId) throw new Error('workspaces:answerQuestion rejected — missing workspace id')
    if (!body.agentId) throw new Error('workspaces:answerQuestion rejected — missing agent id')
    if (!body.questionId) throw new Error('workspaces:answerQuestion rejected — missing question id')
    if (!body.text?.trim()) throw new Error('workspaces:answerQuestion rejected — missing answer text')
    await host.directory.answerQuestion(body.workspaceId, body.agentId, body.questionId, body.text)
    // The badge derives from the question registry; answering mutates it and
    // the registry's onMutate feed pushes — this emit only covers a directory
    // without a push channel.
    emitWorkspaces()
  })

  handle(APP_CHANNELS.workspacesUserMessage, requirePanel, async (_event, payload) => {
    const body = (payload ?? {}) as { workspaceId?: string; text?: string; targetAgentId?: string }
    if (!body.workspaceId) throw new Error('workspaces:userMessage rejected — missing workspace id')
    if (!body.text?.trim()) throw new Error('workspaces:userMessage rejected — missing text')
    const target = typeof body.targetAgentId === 'string' ? body.targetAgentId.trim() : ''
    await host.directory.postUserMessage(
      body.workspaceId,
      body.text.trim(),
      target.length > 0 ? target : undefined
    )
  })

  handle(APP_CHANNELS.workspacesPromoteAgent, requirePanel, async (_event, payload) => {
    const body = (payload ?? {}) as { workspaceId?: string; agentId?: string }
    if (!body.workspaceId) throw new Error('workspaces:promoteAgent rejected — missing workspace id')
    if (!body.agentId) throw new Error('workspaces:promoteAgent rejected — missing agent id')
    await host.directory.promoteAgentBranch(body.workspaceId, body.agentId)
  })

  // Panel-only by construction: `requirePanel` is the same guard the workspace
  // lifecycle uses, and the remote gateway holds an allow-list of verbs rather
  // than a mirror of these channels — so this one cannot be reached from a
  // paired browser at all.
  handle(APP_CHANNELS.workspacesOpenRunFolder, requirePanel, async (_event, payload) => {
    const workspaceId =
      typeof payload === 'string' ? payload : (payload as { workspaceId?: string })?.workspaceId
    if (!workspaceId) throw new Error('workspaces:openRunFolder rejected — missing workspace id')
    await host.directory.openRunFolder(workspaceId)
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

  // --- retro ---------------------------------------------------------------

  handle(APP_CHANNELS.retroList, requirePanel, (_event, payload) => {
    const profileId =
      typeof payload === 'string' ? payload : (payload as { profileId?: string })?.profileId
    const retros = host.store.getRunRetros()
    return profileId ? retros.filter((retro) => retro.profileId === profileId) : retros
  })

  handle(APP_CHANNELS.retroLearnings, requirePanel, (_event, payload) => {
    const profileId =
      typeof payload === 'string' ? payload : (payload as { profileId?: string })?.profileId
    const learnings = host.store.getModelLearnings()
    // Soft filter: a learning without profile context is model knowledge that
    // holds everywhere, so it shows for every profile.
    return profileId
      ? learnings.filter((learning) => !learning.profileId || learning.profileId === profileId)
      : learnings
  })

  handle(APP_CHANNELS.retroDeleteLearning, requirePanel, (_event, payload) => {
    const id = typeof payload === 'string' ? payload : (payload as { id?: string })?.id
    if (!id) throw new Error('retro:deleteLearning rejected — missing learning id')
    return host.store.deleteModelLearning(id)
  })

  handle(APP_CHANNELS.retroRepoNotes, requirePanel, (_event, payload) => {
    const profileId =
      typeof payload === 'string' ? payload : (payload as { profileId?: string })?.profileId
    return host.store.getRepoNotes(profileId || undefined)
  })

  handle(APP_CHANNELS.retroDeleteRepoNote, requirePanel, (_event, payload) => {
    const id = typeof payload === 'string' ? payload : (payload as { id?: string })?.id
    if (!id) throw new Error('retro:deleteRepoNote rejected — missing note id')
    return host.store.deleteRepoNote(id)
  })

  // --- run archive (panel-only; no remote verb) --------------------------

  handle(APP_CHANNELS.runsList, requirePanel, async (_event, payload) => {
    const profileId =
      typeof payload === 'string' ? payload : (payload as { profileId?: string })?.profileId
    if (!profileId) throw new Error('runs:list rejected — missing profile id')
    const profile = host.store.getProfiles().find((entry) => entry.id === profileId)
    if (!profile) throw new Error(`runs:list rejected — unknown profile ${profileId}`)
    if (!profile.repoPath.trim()) return []
    return listRuns(profile.repoPath, profileId)
  })

  handle(APP_CHANNELS.runsGet, requirePanel, async (_event, payload) => {
    const body = (payload ?? {}) as { profileId?: string; workspaceId?: string }
    if (!body.profileId) throw new Error('runs:get rejected — missing profile id')
    if (!body.workspaceId) throw new Error('runs:get rejected — missing workspace id')
    const profile = host.store.getProfiles().find((entry) => entry.id === body.profileId)
    if (!profile) throw new Error(`runs:get rejected — unknown profile ${body.profileId}`)
    if (!profile.repoPath.trim()) {
      throw new Error('runs:get rejected — profile has no repository path')
    }
    const view = await readRun(profile.repoPath, body.profileId, body.workspaceId)
    if (!view) throw new Error(`runs:get rejected — unknown run ${body.workspaceId}`)
    return view
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
   * Three of the keys have an effect that must happen NOW, not at the next
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
        case 'onboardingDismissed': {
          if (typeof body.value !== 'boolean') {
            throw new Error('settings:set rejected — onboardingDismissed expects a boolean')
          }
          const ui = { ...host.store.getSettings().ui, onboardingDismissed: body.value }
          return panelSettings(host.store.setSetting('ui', ui))
        }
        case 'theme':
        case 'locale': {
          // `ui` is one strict object in the schema: read, patch, write back.
          const ui = { ...host.store.getSettings().ui, [key]: body.value }
          const stored = host.store.setSetting('ui', ui)
          // Locale is the voice session's language hint — recreate while live.
          if (key === 'locale' && stored.voice.enabled) {
            await host.voice?.setEnabled(true)
          }
          return panelSettings(stored)
        }
        case 'voice': {
          const merged = mergeVoicePatch(host.store.getSettings().voice, body.value)
          const stored = host.store.setSetting('voice', merged)
          await host.voice?.setEnabled(stored.voice.enabled)
          return panelSettings(stored)
        }
        case 'agentPolicy': {
          // D4: the store mirrors `yoloMaster` on this write, so the panel's
          // toggle and this picker can never show two different truths.
          const policy = AGENT_POLICIES.find((tier) => tier === body.value)
          if (!policy) {
            throw new Error(
              `settings:set rejected — agentPolicy expects ${AGENT_POLICIES.join(', ')}`
            )
          }
          return panelSettings(host.store.setSetting('agentPolicy', policy))
        }
        case 'piHarnessEnabled': {
          if (typeof body.value !== 'boolean') {
            throw new Error('settings:set rejected — piHarnessEnabled expects a boolean')
          }
          return panelSettings(host.store.setSetting('piHarnessEnabled', body.value))
        }
        case 'mcpServers': {
          try {
            const merged = mergeMcpServersPatch(host.store.getSettings().mcpServers, body.value)
            return panelSettings(host.store.setSetting('mcpServers', merged))
          } catch (error) {
            const message = error instanceof Error ? error.message : 'invalid mcpServers'
            if (message.startsWith('settings:set rejected')) throw error
            throw new Error(`settings:set rejected — ${message}`)
          }
        }
        case 'cliSurface': {
          if (!isCliSurface(body.value)) {
            throw new Error('settings:set rejected — cliSurface expects session or raw')
          }
          const ui = { ...host.store.getSettings().ui, cliSurface: body.value }
          return panelSettings(host.store.setSetting('ui', ui))
        }
        case 'reflowNeighbors': {
          if (typeof body.value !== 'boolean') {
            throw new Error('settings:set rejected — reflowNeighbors expects a boolean')
          }
          const ui = { ...host.store.getSettings().ui, reflowNeighbors: body.value }
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

  handle(APP_CHANNELS.voiceStatus, requirePanel, () => {
    if (host.voice) return host.voice.status()
    return { phase: 'idle' as const, enabled: host.store.getSettings().voice.enabled }
  })

  handle(APP_CHANNELS.voiceSetEnabled, requirePanel, async (_event, payload) => {
    const enabled =
      typeof payload === 'boolean' ? payload : (payload as { enabled?: boolean })?.enabled
    if (typeof enabled !== 'boolean') {
      throw new Error('voice:setEnabled rejected — expected a boolean')
    }
    const current = host.store.getSettings()
    const stored = host.store.setSetting('voice', { ...current.voice, enabled })
    emitSettings(panelSettings(stored))
    if (host.voice) {
      await host.voice.setEnabled(enabled)
      return host.voice.status()
    }
    return { phase: 'idle' as const, enabled }
  })

  host.ipcMain.on(APP_CHANNELS.voicePcm, ((event: IpcEvent, payload?: unknown): void => {
    // Fire-and-forget: a CLI window that sends PCM is ignored, never thrown.
    if (!host.isPanelSender(event.sender.id)) return
    const pcm = asInt16Pcm(payload)
    if (pcm) host.voice?.pushPcm(pcm)
  }) as IpcListener)

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
    const body =
      typeof payload === 'string'
        ? { profileId: payload }
        : ((payload ?? {}) as { profileId?: string; providerId?: string })
    host.openProfileEditor(body.profileId || undefined, body.providerId || undefined)
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
    const ui = host.store.getSettings().ui
    return {
      ...zoneEditorPayload(
        profile,
        host.store.getRoleTemplates(),
        sender.displayId,
        host.listZoneDisplays?.() ?? [],
        sender.pick
      ),
      locale: ui.locale,
      theme: ui.theme,
      reflowNeighbors: ui.reflowNeighbors
    }
  })

  handle(APP_CHANNELS.zonesSave, requireZoneOverlay, (event, payload) => {
    const sender = requireZoneOverlay(event, APP_CHANNELS.zonesSave)
    const body = (payload ?? {}) as { profileId?: string; zones?: unknown; reflowNeighbors?: unknown }
    if (body.profileId && body.profileId !== sender.profileId) {
      throw new Error('zones:save rejected — profile does not belong to this overlay')
    }
    const profile = host.store.getProfiles().find((entry) => entry.id === sender.profileId)
    if (!profile) throw new Error(`zones:save rejected — unknown profile ${sender.profileId}`)

    // Optional overlay toggle: a boolean writes through so the settings window
    // follows. A missing or malformed flag is ignored — this channel's job is
    // the layout.
    persistReflowNeighbors(body)

    // The acting overlay's own rectangles are the freshest version of its
    // display; the other displays come from the drafts they pushed while the
    // user was dragging.
    zoneDrafts.set(sender.displayId, parseDraftZones(body.zones, sender.displayId))
    const zones = mergeZoneLayout(
      profile.zones,
      zoneDrafts,
      host.zoneOverlayDisplayIds(),
      sender.displayId
    )
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

  handle(APP_CHANNELS.zonesPickDisplay, requireZoneOverlay, (event, payload) => {
    const sender = requireZoneOverlay(event, APP_CHANNELS.zonesPickDisplay)
    const requested =
      typeof payload === 'number'
        ? payload
        : typeof (payload as { displayId?: unknown } | undefined)?.displayId === 'number'
          ? (payload as { displayId: number }).displayId
          : sender.displayId
    if (!Number.isInteger(requested)) {
      throw new Error('zones:pickDisplay rejected — missing display id')
    }
    const displays = host.listZoneDisplays?.() ?? []
    if (displays.length > 0 && !displays.some((display) => display.id === requested)) {
      throw new Error(`zones:pickDisplay rejected — unknown display ${requested}`)
    }
    if (host.selectZoneOverlayDisplay?.(requested) === false) {
      throw new Error(`zones:pickDisplay rejected — unknown display ${requested}`)
    }
    const profile = host.store.getProfiles().find((entry) => entry.id === sender.profileId)
    if (!profile) throw new Error(`zones:pickDisplay rejected — unknown profile ${sender.profileId}`)
    // Stamp the target screen now, not only on Save: auto-tiling must honour
    // the pick even if the user never draws a rectangle.
    const zones = mergeZoneLayout(profile.zones, new Map(), [], requested)
    const profiles = host.store.saveProfile({ ...profile, zones })
    emitProfiles(profiles)
    return {
      ...zoneEditorPayload(
        { ...profile, zones },
        host.store.getRoleTemplates(),
        requested,
        displays,
        false
      ),
      locale: host.store.getSettings().ui.locale,
      theme: host.store.getSettings().ui.theme
    }
  })

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
 *
 * `bootError` only applies to the stub path: it is the reason the manager does
 * not exist, and it travels into every workspace refusal.
 */
export function registerAppIpc(
  directory?: WorkspaceDirectory,
  bootError?: string,
  voice?: AppVoicePort
): AppIpc {
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
    getRunRetros: () => settings().getRunRetros(),
    getModelLearnings: () => settings().getModelLearnings(),
    deleteModelLearning: (id) => settings().deleteModelLearning(id),
    getRepoNotes: (profileId) => settings().getRepoNotes(profileId),
    deleteRepoNote: (id) => settings().deleteRepoNote(id),
    getSettings: () => settings().getSettings(),
    setSetting: (key, value) => settings().setSetting(key, value)
  }
  instance = createAppIpc({
    ipcMain: ipcMain as unknown as MinimalIpcMain,
    store,
    directory:
      directory ??
      createStubWorkspaceDirectory(() => settings().getSettings().ui.locale, bootError),
    isPanelSender: (id) => isPanelWindowSender(id),
    profileEditorSender: (id) => isProfileEditorWindowSender(id),
    providerEditorSender: (id) => isProviderEditorWindowSender(id),
    discoverModels: (config) =>
      discoverModels(config, {
        locale: () => readLocale(() => settings().getSettings().ui.locale)
      }),
    checkProviders: (configs) => checkAllProviders(configs),
    checkProviderAuth: (configs) => checkAllProviderAuth(configs),
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
    async pickSaveFile(webContentsId, options) {
      const owner = BrowserWindow.getAllWindows().find(
        (candidate) => candidate.webContents.id === webContentsId
      )
      const dialogOptions: Electron.SaveDialogOptions = {
        title: options.title,
        defaultPath: options.defaultPath,
        filters: [{ name: options.filterName, extensions: ['json'] }]
      }
      const result = owner
        ? await dialog.showSaveDialog(owner, dialogOptions)
        : await dialog.showSaveDialog(dialogOptions)
      return result.canceled ? null : (result.filePath ?? null)
    },
    async pickOpenFile(webContentsId, options) {
      const owner = BrowserWindow.getAllWindows().find(
        (candidate) => candidate.webContents.id === webContentsId
      )
      const dialogOptions: Electron.OpenDialogOptions = {
        title: options.title,
        properties: ['openFile'],
        filters: [{ name: options.filterName, extensions: ['json'] }]
      }
      const result = owner
        ? await dialog.showOpenDialog(owner, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions)
      return result.canceled ? null : (result.filePaths[0] ?? null)
    },
    writeTextFile(path, text) {
      writeFileSync(path, text, 'utf8')
    },
    readTextFile(path) {
      return readFileSync(path, 'utf8')
    },
    fileSize(path) {
      return statSync(path).size
    },
    openProfileEditor: (profileId, providerId) => {
      openProfileEditorWindow(profileId, providerId)
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
      const locale = readLocale(() => settings().getSettings().ui.locale)
      const { title, message, detail, confirm, cancel } = quitConfirmationText(
        runningAgents,
        locale
      )
      const owner = getPanelWindow()
      const options: Electron.MessageBoxOptions = {
        type: 'warning',
        // Cancel is the default: an accidental Enter must not kill a team.
        buttons: [confirm, cancel],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        title,
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
    selectZoneOverlayDisplay: (displayId) => selectZoneOverlayDisplay(displayId),
    listZoneDisplays: () => listZoneDisplays(),
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
    onUpdateState: (listener) => onUpdateState(listener),
    voice
  })
  return instance
}

/** Test seam / restart support. */
export function disposeAppIpc(): void {
  instance?.dispose()
  instance = undefined
}
