/**
 * Declarative IPC channel manifest — the single source of truth for the
 * renderer↔main IPC surface (Audit A4 follow-up to the triplicate guard).
 *
 * One entry per channel describes:
 *   - the wire channel name (via the IPC constants, which stay the naming home),
 *   - the direction (`invoke` | `send` | `event` | `local`),
 *   - the `window.vertragus` API path the preload exposes it under,
 *   - the authorization level the main process enforces,
 *   - how the payload is validated (`schema` = central zod parse via
 *     src/shared/ipcManifestSchemas.ts, `handler` = inside the handler body,
 *     `none` = channel takes no renderer payload).
 *
 * Type safety: the phantom `__api` type of every entry is derived FROM the
 * `VertragusApi` member at its `api` path (see {@link ApiAtPath}), so manifest
 * and ipc.ts types cannot diverge. `buildVertragusApi` constructs the preload
 * bridge generically from these entries; src/main/ipc/registerManifest.ts
 * derives the typed handler map and applies auth + zod centrally.
 *
 * This module stays zod-free and electron-free on purpose: it is imported by
 * the preload bundle. Zod schema bindings live in ipcManifestSchemas.ts and
 * are only imported by the main process.
 */
import { IPC, type VertragusApi } from './ipc'

// ---------------------------------------------------------------------------
// API paths: every function member of VertragusApi, one or two levels deep.
// ---------------------------------------------------------------------------

type AnyApiFn = (...args: never[]) => unknown

/** Dotted paths of all function members of VertragusApi (max one group level). */
export type ApiFnPath = {
  [K in keyof VertragusApi & string]: VertragusApi[K] extends AnyApiFn
    ? K
    : {
        [K2 in keyof VertragusApi[K] & string]: `${K}.${K2}`
      }[keyof VertragusApi[K] & string]
}[keyof VertragusApi & string]

/** The VertragusApi member type at a dotted path. */
export type ApiAtPath<P extends string> = P extends `${infer G}.${infer M}`
  ? G extends keyof VertragusApi
    ? M extends keyof VertragusApi[G]
      ? VertragusApi[G][M]
      : never
    : never
  : P extends keyof VertragusApi
    ? VertragusApi[P]
    : never

// ---------------------------------------------------------------------------
// Channel spec
// ---------------------------------------------------------------------------

/**
 * Authorization level, enforced centrally by the main-side registrar
 * (src/main/ipc/registerManifest.ts) before the handler runs:
 *   - 'any'          deliberately reachable from every window — `note` says why
 *   - 'not-voice'    refuses the voice overlay (invoke: throws; send: drops)
 *   - 'main-window'  main window only (throws)
 *   - 'voice-window' voice overlay only (send: drops everything else)
 *   - 'controller'   an authorizing controller inside the handler checks the sender
 *   - 'custom'       bespoke guard inside the handler (guardVoiceTurnAllowed, …)
 */
export type IpcAuthLevel =
  | 'any'
  | 'not-voice'
  | 'main-window'
  | 'voice-window'
  | 'controller'
  | 'custom'

/**
 * Payload validation mode:
 *   - 'schema'  central zod parse; the schema is bound in ipcManifestSchemas.ts
 *   - 'handler' the handler body validates (shared asserts / controller / service)
 *   - 'none'    the channel takes no renderer payload
 */
export type IpcValidationMode = 'schema' | 'handler' | 'none'

export type IpcChannelKind = 'invoke' | 'send' | 'event' | 'local'

interface SpecCommon {
  /** Justification for auth 'any', validation exceptions, aliases, … */
  note?: string
}

export interface InvokeSpecOpts extends SpecCommon {
  auth: IpcAuthLevel
  validation: IpcValidationMode
  /** Index of the renderer argument the central schema parses (default 0). */
  schemaArg?: number
  /** Central parse lets `undefined` through untouched (optional payload). */
  schemaOptional?: boolean
  /** The preload builds this member by hand (argument transform). */
  bridge?: 'custom'
}

export interface IpcChannelSpec<P extends string = string, F = unknown> extends SpecCommon {
  channel: string
  kind: IpcChannelKind
  /** Dotted `window.vertragus` path this channel is exposed under. */
  api: P
  auth?: IpcAuthLevel
  validation?: IpcValidationMode
  schemaArg?: number
  schemaOptional?: boolean
  bridge?: 'custom'
  /** Phantom carrier of the VertragusApi member type — never set at runtime. */
  __api?: F
}

function invoke<P extends ApiFnPath, const O extends InvokeSpecOpts>(
  channel: string,
  api: P,
  opts: O
): { channel: string; kind: 'invoke'; api: P; __api?: ApiAtPath<P> } & O {
  return { channel, kind: 'invoke', api, ...opts }
}

function send<P extends ApiFnPath, const O extends InvokeSpecOpts>(
  channel: string,
  api: P,
  opts: O
): { channel: string; kind: 'send'; api: P; __api?: ApiAtPath<P> } & O {
  return { channel, kind: 'send', api, ...opts }
}

function event<P extends ApiFnPath>(
  channel: string,
  api: P,
  note?: string
): { channel: string; kind: 'event'; api: P; note?: string; __api?: ApiAtPath<P> } {
  return { channel, kind: 'event', api, note }
}

/** Preload-local member that never crosses IPC (webUtils etc.). */
function local<P extends ApiFnPath>(
  api: P,
  note: string
): { channel: ''; kind: 'local'; api: P; bridge: 'custom'; note: string; __api?: ApiAtPath<P> } {
  return { channel: '', kind: 'local', api, bridge: 'custom', note }
}

// ---------------------------------------------------------------------------
// The manifest. Keys match the IPC constant keys (plus documented aliases).
// ---------------------------------------------------------------------------

export const ipcManifest = {
  // ---- app / updates / diagnostics ----
  appInfo: invoke(IPC.appInfo, 'getAppInfo', {
    auth: 'any',
    validation: 'none',
    note: 'read-only app metadata'
  }),
  appUpdateState: invoke(IPC.appUpdateState, 'updates.state', {
    auth: 'any',
    validation: 'none',
    note: 'read-only updater state'
  }),
  appUpdateCheck: invoke(IPC.appUpdateCheck, 'updates.check', {
    auth: 'any',
    validation: 'none',
    note: 'benign trigger; updater state is broadcast to all windows anyway'
  }),
  appUpdateDownload: invoke(IPC.appUpdateDownload, 'updates.download', {
    auth: 'any',
    validation: 'none',
    note: 'benign trigger of the signed-update download'
  }),
  appUpdateInstall: invoke(IPC.appUpdateInstall, 'updates.install', {
    auth: 'any',
    validation: 'none',
    note: 'installs an already verified update; no payload'
  }),
  appUpdateSetChannel: invoke(IPC.appUpdateSetChannel, 'updates.setChannel', {
    auth: 'not-voice',
    validation: 'handler',
    note: 'inline whitelist: anything but "stable" falls back to "main"'
  }),
  diagnosticsExportLatest: invoke(IPC.diagnosticsExportLatest, 'diagnostics.exportLatest', {
    auth: 'any',
    validation: 'handler',
    note:
      'read-only redacted export via a native save dialog parented to the sender; ' +
      'profileId String()-coerced, only used as a journal list filter'
  }),

  // ---- providers / config ----
  providersHealth: invoke(IPC.providersHealth, 'checkProviders', {
    auth: 'any',
    validation: 'none',
    note: 'read-only provider probe'
  }),
  providersCapacity: invoke(IPC.providersCapacity, 'getProviderCapacity', {
    auth: 'any',
    validation: 'none',
    note: 'read-only concurrency snapshot'
  }),
  providersModels: invoke(IPC.providersModels, 'listModels', {
    auth: 'any',
    validation: 'none',
    note: 'read-only model catalog'
  }),
  providerLogin: invoke(IPC.providerLogin, 'loginProvider', {
    auth: 'any',
    validation: 'handler',
    note: 'opens the provider CLI login pane; no secrets cross the bridge'
  }),
  configGet: invoke(IPC.configGet, 'getConfig', {
    auth: 'any',
    validation: 'handler',
    bridge: 'custom',
    note: 'public config keys only (allow-listed in configAccess); preload pre-validates the key'
  }),
  configSet: invoke(IPC.configSet, 'setConfig', {
    auth: 'any',
    validation: 'handler',
    bridge: 'custom',
    note: 'public config keys only; every window may persist shared UI settings'
  }),

  // ---- profiles / workspace sessions / restart recovery ----
  profilesList: invoke(IPC.profilesList, 'listProfiles', {
    auth: 'any',
    validation: 'none',
    note: 'read-only'
  }),
  profileSave: invoke(IPC.profileSave, 'saveProfile', {
    auth: 'controller',
    validation: 'handler',
    note: 'profileSaveController authorizes the sender and zod-parses the profile'
  }),
  profileDelete: invoke(IPC.profileDelete, 'deleteProfile', {
    auth: 'controller',
    validation: 'handler',
    note: 'profileDeletionController authorizes the sender and validates the id'
  }),
  profileGenerateForRepo: invoke(IPC.profileGenerateForRepo, 'generateProfileForRepo', {
    auth: 'not-voice',
    validation: 'handler',
    note:
      'DRIFT: request forwarded without zod at the boundary; validation lives inside generateProfileForRepo'
  }),
  profileGetActive: invoke(IPC.profileGetActive, 'getActiveProfileId', {
    auth: 'any',
    validation: 'none',
    note: 'read-only'
  }),
  profileSetActive: invoke(IPC.profileSetActive, 'setActiveProfileId', {
    auth: 'any',
    validation: 'handler',
    note: 'selection pointer only; existence-checked against the store'
  }),
  workspaceSessionsList: invoke(IPC.workspaceSessionsList, 'workspaceSessions.list', {
    auth: 'controller',
    validation: 'handler',
    note: 'workspaceSessionController authorizes + validates'
  }),
  workspaceSessionSetActive: invoke(IPC.workspaceSessionSetActive, 'workspaceSessions.setActive', {
    auth: 'controller',
    validation: 'handler',
    note: 'workspaceSessionController authorizes + validates'
  }),
  workspaceSessionRemove: invoke(IPC.workspaceSessionRemove, 'workspaceSessions.remove', {
    auth: 'controller',
    validation: 'handler',
    note: 'workspaceSessionController authorizes + validates'
  }),
  sessionsRestoreStatus: invoke(IPC.sessionsRestoreStatus, 'sessions.restoreStatus', {
    auth: 'not-voice',
    validation: 'none'
  }),
  sessionsRestartAgents: invoke(IPC.sessionsRestartAgents, 'sessions.restartAgents', {
    auth: 'not-voice',
    validation: 'handler',
    note: 'inline typeof checks on profileId/sessionId'
  }),
  sessionsDiscardOrphanWorktree: invoke(
    IPC.sessionsDiscardOrphanWorktree,
    'sessions.discardOrphanWorktree',
    {
      auth: 'not-voice',
      validation: 'handler',
      note: 'inline typeof check; path is matched against recorded orphans'
    }
  ),
  sessionsDiscardOrphanWorktrees: invoke(
    IPC.sessionsDiscardOrphanWorktrees,
    'sessions.discardOrphanWorktrees',
    {
      auth: 'not-voice',
      validation: 'handler',
      note: 'inline Array/typeof checks'
    }
  ),

  // ---- MCP ----
  mcpList: invoke(IPC.mcpList, 'listMcpServers', {
    auth: 'any',
    validation: 'none',
    note: 'read-only (mcpSave is voice-guarded)'
  }),
  // mcpSave persists an arbitrary stdio command that is launched on the next agent
  // spawn — a code-execution primitive that must never be reachable from the voice overlay.
  mcpSave: invoke(IPC.mcpSave, 'saveMcpServers', {
    auth: 'not-voice',
    validation: 'schema'
  }),

  // ---- git / github ----
  gitSwitchBranch: invoke(IPC.gitSwitchBranch, 'gitSwitchBranch', {
    auth: 'not-voice',
    validation: 'handler'
  }),
  gitInfo: invoke(IPC.gitInfo, 'gitInfo', {
    auth: 'any',
    validation: 'handler',
    note: 'read-only repository inspection'
  }),
  githubProjects: invoke(IPC.githubProjects, 'githubProjects', {
    auth: 'any',
    validation: 'handler',
    note: 'read-only board listing'
  }),
  githubAuthStatus: invoke(IPC.githubAuthStatus, 'githubAuthStatus', {
    auth: 'any',
    validation: 'none',
    note: 'read-only auth status (never tokens)'
  }),
  githubAuthLogin: invoke(IPC.githubAuthLogin, 'githubAuthLogin', {
    auth: 'not-voice',
    validation: 'none'
  }),
  githubAuthLogout: invoke(IPC.githubAuthLogout, 'githubAuthLogout', {
    auth: 'not-voice',
    validation: 'none'
  }),
  githubRepoSearch: invoke(IPC.githubRepoSearch, 'githubRepoSearch', {
    auth: 'not-voice',
    validation: 'handler'
  }),
  githubRepoResolve: invoke(IPC.githubRepoResolve, 'githubRepoResolve', {
    auth: 'any',
    validation: 'handler',
    note: 'read-only repo metadata lookup'
  }),
  githubRepoBind: invoke(IPC.githubRepoBind, 'githubRepoBind', {
    auth: 'not-voice',
    validation: 'schema'
  }),
  githubRepoCheckLocal: invoke(IPC.githubRepoCheckLocal, 'githubRepoCheckLocal', {
    auth: 'any',
    validation: 'handler',
    note: 'read-only local clone check'
  }),
  githubListIssues: invoke(IPC.githubListIssues, 'github.listIssues', {
    auth: 'not-voice',
    validation: 'schema'
  }),

  // ---- native pickers / demo ----
  dialogPickFolder: invoke(IPC.dialogPickFolder, 'pickFolder', {
    auth: 'any',
    validation: 'none',
    note: 'native picker; user interaction required, returns a user-chosen path'
  }),
  dialogPickFile: invoke(IPC.dialogPickFile, 'pickFile', {
    auth: 'any',
    validation: 'none',
    note: 'native picker; returns a short-lived grant, not a raw path'
  }),
  demoPlay: invoke(IPC.demoPlay, 'demo.play', {
    auth: 'any',
    validation: 'none',
    note: 'pushes demo state only into the requesting window'
  }),

  // ---- ideas inbox ----
  ideasList: invoke(IPC.ideasList, 'inbox.list', {
    auth: 'any',
    validation: 'none',
    note: 'read-only inbox listing'
  }),
  ideasGet: invoke(IPC.ideasGet, 'inbox.get', {
    auth: 'any',
    validation: 'handler',
    note: 'read-only'
  }),
  ideasCreate: invoke(IPC.ideasCreate, 'inbox.create', {
    auth: 'any',
    validation: 'schema',
    schemaOptional: true,
    note: 'inbox capture is intentionally reachable from every window (zod-parsed)'
  }),
  ideasUpdate: invoke(IPC.ideasUpdate, 'inbox.update', {
    auth: 'any',
    validation: 'schema',
    note: 'inbox mutation accepted from every window (zod-parsed)'
  }),
  ideasDelete: invoke(IPC.ideasDelete, 'inbox.delete', {
    auth: 'any',
    validation: 'handler',
    note: 'inbox mutation accepted from every window (id-validated)'
  }),
  ideasAddArtifact: invoke(IPC.ideasAddArtifact, 'inbox.addArtifact', {
    auth: 'any',
    validation: 'schema',
    schemaArg: 1,
    note: 'inbox mutation accepted from every window (ideaId asserted in the handler, input zod-parsed)'
  }),
  ideasRemoveArtifact: invoke(IPC.ideasRemoveArtifact, 'inbox.removeArtifact', {
    auth: 'any',
    validation: 'handler',
    note: 'inbox mutation accepted from every window (id-validated)'
  }),
  ideasRemoveAttribute: invoke(IPC.ideasRemoveAttribute, 'inbox.removeAttribute', {
    auth: 'controller',
    validation: 'handler',
    note: 'inboxArchiveController authorizes + validates'
  }),
  ideasRestore: invoke(IPC.ideasRestore, 'inbox.restoreIdea', {
    auth: 'controller',
    validation: 'handler',
    note: 'inboxArchiveController authorizes + validates'
  }),
  ideasTransferToProfile: invoke(IPC.ideasTransferToProfile, 'inbox.transferToProfile', {
    auth: 'any',
    validation: 'schema',
    note: 'transfer request is zod-parsed; orchestrator start runs its own gates'
  }),
  ideasTransferRetry: invoke(IPC.ideasTransferRetry, 'inbox.transferRetry', {
    auth: 'any',
    validation: 'handler',
    note: 'id-validated retry of a previously authorized transfer'
  }),
  ideasEnhancePrompt: invoke(IPC.ideasEnhancePrompt, 'inbox.enhancePrompt', {
    auth: 'controller',
    validation: 'handler',
    note: 'promptController authorizes the sender and zod-parses the request'
  }),
  ideasAbortPromptEnhancement: invoke(
    IPC.ideasAbortPromptEnhancement,
    'inbox.abortPromptEnhancement',
    {
      auth: 'controller',
      validation: 'handler',
      bridge: 'custom',
      note: 'preload wraps the requestId into { requestId }; promptController authorizes + validates'
    }
  ),
  ideasTransferReset: invoke(IPC.ideasTransferReset, 'inbox.transferReset', {
    auth: 'any',
    validation: 'handler',
    note: 'id-validated metadata reset'
  }),

  // ---- inbox speech-to-text ----
  inboxSpeechStatus: invoke(IPC.inboxSpeechStatus, 'inboxSpeech.status', {
    auth: 'any',
    validation: 'none',
    note: 'read-only STT status'
  }),
  inboxSpeechGetSettings: invoke(IPC.inboxSpeechGetSettings, 'inboxSpeech.getSettings', {
    auth: 'any',
    validation: 'none',
    note: 'settings expose key presence as booleans only'
  }),
  inboxSpeechSetSettings: invoke(IPC.inboxSpeechSetSettings, 'inboxSpeech.setSettings', {
    auth: 'any',
    validation: 'schema',
    note: 'zod-parsed patch; raw keys never leave the main process'
  }),
  inboxSpeechTranscribe: invoke(IPC.inboxSpeechTranscribe, 'inboxSpeech.transcribe', {
    auth: 'any',
    validation: 'handler',
    note: 'bounded base64 audio payload enforced inside transcribeInboxAudio'
  }),
  inboxSpeechAbort: invoke(IPC.inboxSpeechAbort, 'inboxSpeech.abort', {
    auth: 'any',
    validation: 'none',
    note: 'aborts the single in-flight transcription; no payload'
  }),

  // ---- Mission Control (desktop administration only) ----
  remoteStatus: invoke(IPC.remoteStatus, 'remote.status', {
    auth: 'main-window',
    validation: 'none'
  }),
  remoteEnable: invoke(IPC.remoteEnable, 'remote.enable', {
    auth: 'main-window',
    validation: 'handler',
    note: 'request validated inside remoteService.enable'
  }),
  remoteDisable: invoke(IPC.remoteDisable, 'remote.disable', {
    auth: 'main-window',
    validation: 'none'
  }),
  remoteListDevices: invoke(IPC.remoteListDevices, 'remote.listDevices', {
    auth: 'main-window',
    validation: 'none'
  }),
  remoteRevokeDevice: invoke(IPC.remoteRevokeDevice, 'remote.revokeDevice', {
    auth: 'main-window',
    validation: 'handler',
    note: 'deviceId String()-coerced'
  }),
  remotePairStart: invoke(IPC.remotePairStart, 'remote.pairStart', {
    auth: 'main-window',
    validation: 'handler',
    note: 'optional request validated inside remoteService.startPairing'
  }),
  remoteSetApnsConfig: invoke(IPC.remoteSetApnsConfig, 'remote.setApnsConfig', {
    auth: 'main-window',
    validation: 'handler',
    note: 'config validated inside remoteService.setApnsConfig'
  }),
  remoteGetApnsConfigStatus: invoke(IPC.remoteGetApnsConfigStatus, 'remote.getApnsConfigStatus', {
    auth: 'main-window',
    validation: 'none'
  }),
  remoteClearApnsConfig: invoke(IPC.remoteClearApnsConfig, 'remote.clearApnsConfig', {
    auth: 'main-window',
    validation: 'none'
  }),

  // ---- agents ----
  agentsList: invoke(IPC.agentsList, 'agents.list', {
    auth: 'any',
    validation: 'none',
    note: 'read-only agent listing'
  }),
  agentSpawn: invoke(IPC.agentSpawn, 'agents.spawn', {
    auth: 'not-voice',
    validation: 'schema'
  }),
  agentsSpawnProfile: invoke(IPC.agentsSpawnProfile, 'agents.spawnProfile', {
    auth: 'not-voice',
    validation: 'handler'
  }),
  agentWrite: send(IPC.agentWrite, 'agents.write', {
    auth: 'not-voice',
    validation: 'handler',
    note: 'hot pty path; unknown ids are dropped inside AgentManager.write'
  }),
  agentMarkInteractiveUsed: send(IPC.agentMarkInteractiveUsed, 'agents.markInteractiveUsed', {
    auth: 'not-voice',
    validation: 'handler',
    note: 'unknown ids are ignored inside AgentManager'
  }),
  agentResize: send(IPC.agentResize, 'agents.resize', {
    auth: 'not-voice',
    validation: 'handler',
    note: 'unknown ids are ignored inside AgentManager; cols/rows clamped by pty'
  }),
  agentKill: invoke(IPC.agentKill, 'agents.kill', {
    auth: 'not-voice',
    validation: 'handler'
  }),
  agentsKillAll: invoke(IPC.agentsKillAll, 'agents.killAll', {
    auth: 'not-voice',
    validation: 'none'
  }),
  agentsClean: invoke(IPC.agentsClean, 'agents.clean', {
    auth: 'not-voice',
    validation: 'handler'
  }),
  agentBuffer: invoke(IPC.agentBuffer, 'agents.buffer', {
    auth: 'any',
    validation: 'handler',
    note: 'read-only scrollback replay (id-validated)'
  }),
  agentBufferTail: invoke(IPC.agentBufferTail, 'agents.bufferTail', {
    auth: 'any',
    validation: 'handler',
    note: 'read-only scrollback slice (id-validated)'
  }),
  agentPopout: invoke(IPC.agentPopout, 'agents.popout', {
    auth: 'not-voice',
    validation: 'handler'
  }),
  agentHandoff: invoke(IPC.agentHandoff, 'agents.handoff', {
    auth: 'not-voice',
    validation: 'schema'
  }),
  agentsBulkHandoff: invoke(IPC.agentsBulkHandoff, 'agents.bulkHandoff', {
    auth: 'not-voice',
    validation: 'schema'
  }),

  // ---- orchestrator ----
  orchestratorSnapshot: invoke(IPC.orchestratorSnapshot, 'orchestrator.snapshot', {
    auth: 'any',
    validation: 'handler',
    note: 'read-only snapshot; getProfile lookup is deliberately lenient for deleted profiles'
  }),
  orchestratorReset: invoke(IPC.orchestratorReset, 'orchestrator.reset', {
    auth: 'not-voice',
    validation: 'handler'
  }),
  orchestratorEnableAutoMode: invoke(IPC.orchestratorEnableAutoMode, 'orchestrator.enableAutoMode', {
    auth: 'not-voice',
    validation: 'handler'
  }),
  orchestratorSetPlannerMode: invoke(IPC.orchestratorSetPlannerMode, 'orchestrator.setPlannerMode', {
    auth: 'not-voice',
    validation: 'handler'
  }),
  orchestratorSetYoloMaster: invoke(IPC.orchestratorSetYoloMaster, 'orchestrator.setYoloMaster', {
    auth: 'not-voice',
    validation: 'handler',
    note: 'Boolean() coercion is the whole contract'
  }),
  orchestratorReviewPlan: invoke(IPC.orchestratorReviewPlan, 'orchestrator.reviewPlan', {
    auth: 'not-voice',
    validation: 'handler'
  }),
  orchestratorTaskDiff: invoke(IPC.orchestratorTaskDiff, 'orchestrator.taskDiff', {
    auth: 'any',
    validation: 'handler',
    note: 'read-only size-limited diff from the trusted worktree'
  }),
  orchestratorOpenTaskWorktree: invoke(
    IPC.orchestratorOpenTaskWorktree,
    'orchestrator.openTaskWorktree',
    {
      auth: 'not-voice',
      validation: 'handler'
    }
  ),
  orchestratorApprovePublication: invoke(
    IPC.orchestratorApprovePublication,
    'orchestrator.approvePublication',
    {
      auth: 'not-voice',
      validation: 'handler'
    }
  ),
  orchestratorRejectPublication: invoke(
    IPC.orchestratorRejectPublication,
    'orchestrator.rejectPublication',
    {
      auth: 'not-voice',
      validation: 'handler'
    }
  ),
  orchestratorResolvePermission: invoke(
    IPC.orchestratorResolvePermission,
    'orchestrator.resolvePermission',
    {
      auth: 'not-voice',
      validation: 'handler'
    }
  ),
  orchestratorSetBudgetCaps: invoke(IPC.orchestratorSetBudgetCaps, 'orchestrator.setBudgetCaps', {
    auth: 'not-voice',
    validation: 'handler'
  }),
  orchestratorPauseTask: invoke(IPC.orchestratorPauseTask, 'orchestrator.pauseTask', {
    auth: 'not-voice',
    validation: 'handler'
  }),
  orchestratorResumeTask: invoke(IPC.orchestratorResumeTask, 'orchestrator.resumeTask', {
    auth: 'not-voice',
    validation: 'handler'
  }),
  orchestratorResumeInterruptedTask: invoke(
    IPC.orchestratorResumeInterruptedTask,
    'orchestrator.resumeInterruptedTask',
    {
      auth: 'not-voice',
      validation: 'handler'
    }
  ),
  orchestratorFallbackTask: invoke(IPC.orchestratorFallbackTask, 'orchestrator.fallbackTask', {
    auth: 'not-voice',
    validation: 'handler'
  }),
  // Canvas composer → seed a free-text message to the session's orchestrator agent.
  // Main-window only; the voice window has its own gated tool for this.
  orchestratorSend: invoke(IPC.orchestratorSend, 'orchestrator.send', {
    auth: 'main-window',
    validation: 'handler',
    note: 'validated inside resolveOrchestratorSend (voiceIpc)'
  }),

  // ---- voice assistant + overlay ----
  voiceAssistantTurn: invoke(IPC.voiceAssistantTurn, 'voiceAssistant.turn', {
    auth: 'custom',
    validation: 'handler',
    note:
      'guardVoiceTurnAllowed: only the overlay window (or the main window as fallback host); ' +
      'request adapted + bounded inside adaptVoiceTurnRequest'
  }),
  voiceAssistantGetSettings: invoke(IPC.voiceAssistantGetSettings, 'voiceAssistant.getSettings', {
    auth: 'main-window',
    validation: 'none'
  }),
  voiceAssistantSetSettings: invoke(IPC.voiceAssistantSetSettings, 'voiceAssistant.setSettings', {
    auth: 'main-window',
    validation: 'handler',
    note: 'patch validated inside setVoiceAssistantSettings'
  }),
  voiceOverlayToggle: invoke(IPC.voiceOverlayToggle, 'voiceOverlay.toggle', {
    auth: 'main-window',
    validation: 'none'
  }),
  voiceOverlayHide: invoke(IPC.voiceOverlayHide, 'voiceOverlay.hide', {
    auth: 'custom',
    validation: 'none',
    note: 'guardOverlayControl: overlay self-hide or main window'
  }),
  voiceOverlayMoved: send(IPC.voiceOverlayMoved, 'voiceOverlay.moved', {
    auth: 'voice-window',
    validation: 'handler',
    note: 'Number() coercion of window coordinates'
  }),

  // ---- desktop rail (slim always-on-top launcher) ----
  railToggle: invoke(IPC.railToggle, 'rail.toggle', {
    auth: 'main-window',
    validation: 'none'
  }),
  railOpenMain: invoke(IPC.railOpenMain, 'rail.openMain', {
    auth: 'custom',
    validation: 'none',
    note: 'guardRailControl: rail window or main window'
  }),
  railLaunchTiled: invoke(IPC.railLaunchTiled, 'rail.launchTiled', {
    auth: 'custom',
    validation: 'handler',
    note: 'guardRailControl: rail or main window; profileId existence-checked, yolo Boolean()-coerced'
  }),

  // ---- retro / model learnings / benchmarks ----
  retroListRetros: invoke(IPC.retroListRetros, 'retro.listRetros', {
    auth: 'any',
    validation: 'handler',
    note: 'read-only; optional profileId String()-coerced list filter'
  }),
  retroListLearnings: invoke(IPC.retroListLearnings, 'retro.listLearnings', {
    auth: 'any',
    validation: 'none',
    note: 'read-only'
  }),
  retroListBenchmarks: invoke(IPC.retroListBenchmarks, 'retro.listBenchmarks', {
    auth: 'any',
    validation: 'handler',
    note: 'read-only; optional profileId String()-coerced list filter'
  }),
  retroSyncStatus: invoke(IPC.retroSyncStatus, 'retro.syncStatus', {
    auth: 'any',
    validation: 'none',
    note: 'read-only'
  }),
  retroSyncFlush: invoke(IPC.retroSyncFlush, 'retro.syncFlush', {
    auth: 'any',
    validation: 'none',
    note: 'benign flush of the export queue; no payload'
  }),

  // ---- window controls (frameless title bar) ----
  winMinimize: send(IPC.winMinimize, 'win.minimize', {
    auth: 'any',
    validation: 'none',
    note: 'window control scoped to the sender window itself'
  }),
  winMaximizeToggle: send(IPC.winMaximizeToggle, 'win.maximizeToggle', {
    auth: 'any',
    validation: 'none',
    note: 'window control scoped to the sender window itself'
  }),
  winClose: send(IPC.winClose, 'win.close', {
    auth: 'any',
    validation: 'none',
    note: 'window control scoped to the sender window itself'
  }),

  // ---- attention (taskbar / dock flash) — one-way only ----
  attentionSetPendingFeedbackCount: send(
    IPC.attentionSetPendingFeedbackCount,
    'attention.setPendingFeedbackCount',
    {
      auth: 'controller',
      validation: 'handler',
      note: 'attentionController authorizes + clamps; invalid payloads are dropped without reply'
    }
  ),

  // ---- main → renderer push channels ----
  evAgentData: event(IPC.evAgentData, 'agents.onData'),
  evAgentsChanged: event(IPC.evAgentsChanged, 'agents.onChanged'),
  evVertragusEvent: event(IPC.evVertragusEvent, 'agents.onEvent'),
  evProvidersHealth: event(IPC.evProvidersHealth, 'onProvidersChanged'),
  evAppUpdateState: event(IPC.evAppUpdateState, 'updates.onState'),
  evOrchestrator: event(IPC.evOrchestrator, 'orchestrator.onSnapshot'),
  evWorkspaceSessions: event(IPC.evWorkspaceSessions, 'workspaceSessions.onChanged'),
  evRemote: event(IPC.evRemote, 'remote.onStatus'),
  evVoiceAssistant: event(IPC.evVoiceAssistant, 'events.onVoiceAssistant'),
  evUiCommand: event(IPC.evUiCommand, 'events.onUiCommand'),
  evConfigChanged: event(IPC.evConfigChanged, 'onConfigChanged'),
  evProfilesChanged: event(IPC.evProfilesChanged, 'onProfilesChanged'),
  // Documented alias: voiceAssistant.onProgress subscribes to the same channel
  // as events.onVoiceAssistant (see VertragusApi doc comment).
  voiceAssistantOnProgress: event(
    IPC.evVoiceAssistant,
    'voiceAssistant.onProgress',
    'alias of events.onVoiceAssistant (same ev:voiceAssistant channel)'
  ),

  // ---- preload-local members (no IPC channel) ----
  filesPathForFile: local(
    'files.pathForFile',
    'webUtils.getPathForFile — resolves a renderer File to its filesystem path locally in the preload'
  )
} as const

export type IpcManifest = typeof ipcManifest
export type IpcManifestKey = keyof IpcManifest

// ---------------------------------------------------------------------------
// Static completeness + divergence checks (compile-time only)
// ---------------------------------------------------------------------------

/** The API type derived from the manifest (mapped from the phantom types). */
export type ManifestApiOf<K extends IpcManifestKey> = NonNullable<IpcManifest[K]['__api']>

type CoveredApiPath = IpcManifest[IpcManifestKey]['api']
/** Compile error listing the missing paths when the manifest misses an API member. */
type UncoveredApiPath = Exclude<ApiFnPath, CoveredApiPath>
type StaticAssert<T extends never> = T
export type _EveryApiMemberHasAManifestEntry = StaticAssert<UncoveredApiPath>
/** …and the reverse: every manifest api path exists on VertragusApi. */
type UnknownApiPath = Exclude<CoveredApiPath, ApiFnPath>
export type _EveryManifestEntryTargetsARealApiMember = StaticAssert<UnknownApiPath>

/** Manifest keys whose preload binding is written by hand. */
export type CustomBridgeKey = {
  [K in IpcManifestKey]: IpcManifest[K] extends { bridge: 'custom' } ? K : never
}[IpcManifestKey]

export type CustomBridgeBindings = {
  [K in CustomBridgeKey]: ManifestApiOf<K>
}

// ---------------------------------------------------------------------------
// Runtime helpers
// ---------------------------------------------------------------------------

export interface FlatIpcChannel {
  key: IpcManifestKey
  spec: IpcChannelSpec
}

/** All manifest entries as a flat list (stable manifest order). */
export function listIpcChannels(): FlatIpcChannel[] {
  return (Object.keys(ipcManifest) as IpcManifestKey[]).map((key) => ({
    key,
    spec: ipcManifest[key] as IpcChannelSpec
  }))
}

/**
 * Transport primitives injected by the preload (ipcRenderer) or by tests.
 * Keeping the builder free of electron imports makes it unit-testable.
 */
export interface IpcTransport {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  send(channel: string, ...args: unknown[]): void
  subscribe(channel: string, cb: (payload: unknown) => void): () => void
}

function setAtPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.')
  let cursor = target
  for (const segment of segments.slice(0, -1)) {
    cursor[segment] = cursor[segment] ?? {}
    cursor = cursor[segment] as Record<string, unknown>
  }
  const leaf = segments[segments.length - 1]!
  if (leaf in cursor) {
    throw new Error(`IPC manifest: duplicate api path "${path}"`)
  }
  cursor[leaf] = value
}

/**
 * Builds the complete `window.vertragus` API object from the manifest:
 * pass-through `invoke`/`send` bindings, `subscribe`-with-unsubscribe event
 * bindings, and the explicitly listed custom bindings (argument transforms and
 * preload-local members). The renderer-visible shape is exactly `VertragusApi`
 * — guaranteed by the static checks above.
 */
export function buildVertragusApi(
  transport: IpcTransport,
  custom: CustomBridgeBindings
): VertragusApi {
  const api: Record<string, unknown> = {}
  for (const { key, spec } of listIpcChannels()) {
    let binding: unknown
    if (spec.bridge === 'custom') {
      binding = custom[key as CustomBridgeKey]
      if (typeof binding !== 'function') {
        throw new Error(`IPC manifest: missing custom preload binding for "${key}"`)
      }
    } else if (spec.kind === 'invoke') {
      binding = (...args: unknown[]) => transport.invoke(spec.channel, ...args)
    } else if (spec.kind === 'send') {
      binding = (...args: unknown[]) => transport.send(spec.channel, ...args)
    } else if (spec.kind === 'event') {
      binding = (cb: (payload: unknown) => void) => transport.subscribe(spec.channel, cb)
    } else {
      throw new Error(`IPC manifest: entry "${key}" (kind ${spec.kind}) needs a custom binding`)
    }
    setAtPath(api, spec.api, binding)
  }
  return api as unknown as VertragusApi
}
