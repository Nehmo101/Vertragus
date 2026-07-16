/**
 * IPC channel names and the typed API surface exposed to the renderer via preload.
 * Keeping these in one shared module keeps main <-> preload <-> renderer in sync.
 */
import type { AgentProviderId, ProviderHealth, ProviderId, ProviderModelCatalog } from './providers'
import type {
  ProfileCloneStatus,
  ProfileGithubRepo,
  RepoProfileGenerationRequest,
  WorkspaceProfile
} from './profile'
import type { McpServerConfig } from './mcp'
import type {
  AgentBufferSnapshot,
  AgentDataChunk,
  AgentInstanceInfo,
  HandoffRequest,
  OrcaEvent,
  SpawnAgentRequest
} from './agents'
import type { OrchestratorSnapshot, WorkspaceSessionSummary } from './orchestrator'
import type { BenchmarkRecord, ModelLearning, RunRetro } from './retro'
import type { RetroSyncStatus } from './retroSync'
import type {
  AddArtifactInput,
  CreateIdeaInput,
  Idea,
  IdeaTransferRequest,
  IdeaTransferResult,
  RemovableIdeaAttribute,
  UpdateIdeaInput
} from './inbox'
import type {
  InboxSpeechSettings,
  InboxSpeechSettingsPatch,
  InboxSpeechStatus,
  TranscribeAudioPayload,
  TranscribeAudioResult
} from './inboxSpeech'
import type {
  PromptEnhancementIpcRequest,
  PromptEnhancementIpcResult
} from './promptEnhancement'
import type {
  DeviceInfo,
  PairingChallenge,
  RemoteBudgetCaps,
  RemoteBudgetSnapshot,
  RemoteEnableRequest,
  RemotePairStartRequest,
  RemoteStatus
} from './remote'

export const IPC = {
  appInfo: 'app:info',
  appUpdateState: 'app:updateState',
  appUpdateCheck: 'app:updateCheck',
  appUpdateDownload: 'app:updateDownload',
  appUpdateInstall: 'app:updateInstall',
  diagnosticsExportLatest: 'diagnostics:exportLatest',
  providersHealth: 'providers:health',
  providersCapacity: 'providers:capacity',
  providersModels: 'providers:models',
  providerLogin: 'providers:login',
  configGet: 'config:get',
  configSet: 'config:set',
  profilesList: 'profiles:list',
  profileSave: 'profile:save',
  profileDelete: 'profile:delete',
  profileGenerateForRepo: 'profile:generateForRepo',
  profileGetActive: 'profiles:getActive',
  profileSetActive: 'profiles:setActive',
  workspaceSessionsList: 'workspaceSessions:list',
  workspaceSessionSetActive: 'workspaceSessions:setActive',
  workspaceSessionRemove: 'workspaceSessions:remove',
  mcpList: 'mcp:list',
  mcpSave: 'mcp:save',
  gitSwitchBranch: 'git:switchBranch',
  gitInfo: 'git:info',
  githubProjects: 'github:projects',
  githubAuthStatus: 'github:authStatus',
  githubAuthLogin: 'github:authLogin',
  githubAuthLogout: 'github:authLogout',
  githubRepoSearch: 'github:repoSearch',
  githubRepoResolve: 'github:repoResolve',
  githubRepoBind: 'github:repoBind',
  githubRepoCheckLocal: 'github:repoCheckLocal',
  dialogPickFolder: 'dialog:pickFolder',
  dialogPickFile: 'dialog:pickFile',
  ideasList: 'ideas:list',
  ideasGet: 'ideas:get',
  ideasCreate: 'ideas:create',
  ideasUpdate: 'ideas:update',
  ideasDelete: 'ideas:delete',
  ideasAddArtifact: 'ideas:addArtifact',
  ideasRemoveArtifact: 'ideas:removeArtifact',
  ideasRemoveAttribute: 'ideas:remove-attribute',
  ideasRestore: 'ideas:restore',
  ideasTransferToProfile: 'ideas:transferToProfile',
  ideasTransferRetry: 'ideas:transferRetry',
  ideasEnhancePrompt: 'ideas:enhancePrompt',
  ideasAbortPromptEnhancement: 'ideas:abortPromptEnhancement',
  ideasTransferReset: 'ideas:transferReset',
  inboxSpeechStatus: 'inboxSpeech:status',
  inboxSpeechGetSettings: 'inboxSpeech:getSettings',
  inboxSpeechSetSettings: 'inboxSpeech:setSettings',
  inboxSpeechTranscribe: 'inboxSpeech:transcribe',
  inboxSpeechAbort: 'inboxSpeech:abort',
  agentsList: 'agents:list',
  agentSpawn: 'agent:spawn',
  agentsSpawnProfile: 'agents:spawnProfile',
  agentWrite: 'agent:write',
  agentMarkInteractiveUsed: 'agent:markInteractiveUsed',
  agentResize: 'agent:resize',
  agentKill: 'agent:kill',
  agentsKillAll: 'agents:killAll',
  agentsClean: 'agents:clean',
  agentBuffer: 'agent:buffer',
  agentPopout: 'agent:popout',
  agentHandoff: 'agent:handoff',
  orchestratorSnapshot: 'orchestrator:snapshot',
  orchestratorReset: 'orchestrator:reset',
  orchestratorEnableAutoMode: 'orchestrator:enableAutoMode',
  orchestratorSetPlannerMode: 'orchestrator:setPlannerMode',
  orchestratorReviewPlan: 'orchestrator:reviewPlan',
  orchestratorTaskDiff: 'orchestrator:taskDiff',
  orchestratorApprovePublication: 'orchestrator:approvePublication',
  orchestratorRejectPublication: 'orchestrator:rejectPublication',
  orchestratorResolvePermission: 'orchestrator:resolvePermission',
  orchestratorSetBudgetCaps: 'orchestrator:setBudgetCaps',
  orchestratorPauseTask: 'orchestrator:pauseTask',
  orchestratorResumeTask: 'orchestrator:resumeTask',
  orchestratorFallbackTask: 'orchestrator:fallbackTask',
  remoteStatus: 'remote:status',
  remoteEnable: 'remote:enable',
  remoteDisable: 'remote:disable',
  remoteListDevices: 'remote:listDevices',
  remoteRevokeDevice: 'remote:revokeDevice',
  remotePairStart: 'remote:pairStart',
  retroListRetros: 'retro:listRetros',
  retroListLearnings: 'retro:listLearnings',
  retroListBenchmarks: 'retro:listBenchmarks',
  retroSyncStatus: 'retro:syncStatus',
  retroSyncFlush: 'retro:syncFlush',
  // main -> renderer push channels
  evAgentData: 'ev:agentData',
  evAgentsChanged: 'ev:agentsChanged',
  evOrcaEvent: 'ev:orcaEvent',
  evProvidersHealth: 'ev:providersHealth',
  evAppUpdateState: 'ev:appUpdateState',
  evOrchestrator: 'ev:orchestrator',
  evWorkspaceSessions: 'ev:workspaceSessions',
  evRemote: 'ev:remote',
  // window controls (frameless title bar)
  winMinimize: 'win:minimize',
  winMaximizeToggle: 'win:maximizeToggle',
  winClose: 'win:close'
} as const

export interface AppInfo {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
  platform: NodeJS.Platform
}

export type UpdateStatus =
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'error'

export interface UpdateState {
  status: UpdateStatus
  currentVersion: string
  availableVersion?: string
  progress?: number
  message?: string
}

export interface GitWorktreeInfo {
  path: string
  head?: string
  /** Local branch name without the refs/heads/ prefix. */
  branch?: string
  detached: boolean
  bare: boolean
  /** Optional reason reported by `git worktree list --porcelain`. */
  locked?: string
  /** Optional prune reason reported by `git worktree list --porcelain`. */
  prunable?: string
}

export interface GitInfo {
  isRepo: boolean
  root?: string
  branches?: string[]
  worktrees?: GitWorktreeInfo[]
  branch?: string
  head?: string
  remote?: string
  defaultBranch?: string
  dirty?: boolean
}

export interface GithubProjectSummary {
  owner: string
  number: number
  title: string
  url: string
  closed: boolean
}

export interface GithubProjectsResult {
  owner: string
  projects: GithubProjectSummary[]
}

export type GithubAuthMethod = 'none' | 'gh-cli' | 'oauth'

export interface GithubAuthStatus {
  authenticated: boolean
  method: GithubAuthMethod
  account?: string
  scopes: string[]
  /** Connection-level scopes that are missing (feature-specific scopes are checked on use). */
  missingScopes: string[]
  needsReauth: boolean
  /** True when ORCA_GITHUB_OAUTH_CLIENT_ID or a saved client id is configured. */
  oauthConfigured: boolean
  detail?: string
}

export interface GithubRepoSummary {
  owner: string
  repo: string
  fullName: string
  description?: string
  defaultBranch: string
  url: string
  private: boolean
}

export interface GithubRepoSearchResult {
  repos: GithubRepoSummary[]
  query: string
}

export interface GithubRepoResolveResult {
  owner: string
  repo: string
  defaultBranch: string
  url: string
}

export interface GithubRepoBindRequest {
  owner: string
  repo: string
  defaultBranch?: string
  localPath?: string
  /** Clone into localPath when the directory is missing or empty. */
  clone?: boolean
}

export interface GithubRepoBindResult {
  binding: ProfileGithubRepo
  workingDir: string
  message: string
}

export interface GithubRepoLocalCheck {
  localPath: string
  cloneStatus: ProfileCloneStatus
  remoteUrl?: string
  message: string
}

/** Short-lived grant returned by the native file picker (not a raw filesystem path). */
export interface PickedFileGrant {
  grantId: string
  fileName: string
}

/** Main-process provider concurrency snapshot (authoritative for Limits panel). */
export interface ProviderCapacitySnapshot {
  active: number
  waiting: number
  limit: number
}

export interface TaskReviewDiff {
  taskId: string
  diff: string
  truncated: boolean
}

/**
 * The API bridged onto `window.orca` in the renderer. Every method maps 1:1
 * onto an ipcMain handler (or push channel) registered in the main process.
 */
export interface OrcaApi {
  getAppInfo(): Promise<AppInfo>
  updates: {
    state(): Promise<UpdateState>
    check(): Promise<UpdateState>
    download(): Promise<UpdateState>
    install(): Promise<void>
    onState(cb: (state: UpdateState) => void): () => void
  }
  diagnostics: {
    /** Export the latest redacted JSONL run for a workspace through a native save dialog. */
    exportLatest(profileId: string): Promise<string | null>
  }
  /** Probe every provider CLI/integration for availability + version. */
  checkProviders(): Promise<ProviderHealth[]>
  /** Authoritative per-provider concurrency usage from the main process gate. */
  getProviderCapacity(): Promise<Record<AgentProviderId, ProviderCapacitySnapshot>>
  /** Model options per agent provider (ollama live when reachable). */
  /** Open the provider's official CLI login flow in an interactive Orca terminal. */
  loginProvider(id: ProviderId): Promise<AgentInstanceInfo>
  /** Receive refreshed connection state after an interactive login exits. */
  onProvidersChanged(cb: (health: ProviderHealth[]) => void): () => void
  listModels(): Promise<ProviderModelCatalog>
  getConfig<T = unknown>(key: string): Promise<T | undefined>
  setConfig(key: string, value: unknown): Promise<void>

  listProfiles(): Promise<WorkspaceProfile[]>
  saveProfile(profile: WorkspaceProfile): Promise<WorkspaceProfile[]>
  deleteProfile(id: string): Promise<WorkspaceProfile[]>
  generateProfileForRepo(req: RepoProfileGenerationRequest): Promise<WorkspaceProfile>
  getActiveProfileId(): Promise<string>
  setActiveProfileId(id: string): Promise<void>
  workspaceSessions: {
    list(profileId?: string): Promise<WorkspaceSessionSummary[]>
    setActive(profileId: string, sessionId: string): Promise<OrchestratorSnapshot>
    remove(profileId: string, sessionId: string): Promise<WorkspaceSessionSummary[]>
    onChanged(cb: (sessions: WorkspaceSessionSummary[]) => void): () => void
  }

  /** External MCP servers attached to the launched agents. */
  listMcpServers(): Promise<McpServerConfig[]>
  /** Validate + persist the full MCP server list; returns the stored result. */
  saveMcpServers(servers: McpServerConfig[]): Promise<McpServerConfig[]>

  gitInfo(dir: string): Promise<GitInfo>
  gitSwitchBranch(dir: string, branch: string): Promise<GitInfo>
  /** List GitHub Projects boards for the explicit owner or the workspace origin owner. */
  githubProjects(dir: string, owner?: string): Promise<GithubProjectsResult>
  githubAuthStatus(): Promise<GithubAuthStatus>
  /** Browser-based OAuth (device flow) or gh --web fallback; never returns tokens. */
  githubAuthLogin(): Promise<GithubAuthStatus>
  githubAuthLogout(): Promise<GithubAuthStatus>
  githubRepoSearch(query: string, limit?: number): Promise<GithubRepoSearchResult>
  githubRepoResolve(owner: string, repo: string): Promise<GithubRepoResolveResult>
  githubRepoBind(req: GithubRepoBindRequest): Promise<GithubRepoBindResult>
  githubRepoCheckLocal(
    owner: string,
    repo: string,
    localPath: string
  ): Promise<GithubRepoLocalCheck>
  /** Open a native folder picker; resolves to the chosen path or null. */
  pickFolder(): Promise<string | null>
  /** Open a native file picker for inbox artifacts; returns a short-lived grant. */
  pickFile(): Promise<PickedFileGrant | null>

  inbox: {
    list(): Promise<Idea[]>
    get(id: string): Promise<Idea | undefined>
    create(input?: CreateIdeaInput): Promise<Idea>
    update(input: UpdateIdeaInput): Promise<Idea>
    delete(id: string): Promise<Idea[]>
    addArtifact(ideaId: string, input: AddArtifactInput): Promise<Idea>
    removeArtifact(ideaId: string, artifactId: string): Promise<Idea>
    removeAttribute(ideaId: string, attribute: RemovableIdeaAttribute): Promise<Idea>
    restoreIdea(ideaId: string): Promise<Idea>
    /** Hand idea + artifacts to a workspace profile and start orchestrator planning. */
    transferToProfile(req: IdeaTransferRequest): Promise<IdeaTransferResult>
    /** Retry a failed, retryable transfer for the same profile. */
    transferRetry(ideaId: string, yoloMaster?: boolean): Promise<IdeaTransferResult>
    /** Improve an unsaved local draft. This never persists or transfers the idea. */
    enhancePrompt(req: PromptEnhancementIpcRequest): Promise<PromptEnhancementIpcResult>
    /** Abort only the caller's matching in-flight enhancement request. */
    abortPromptEnhancement(requestId: string): Promise<boolean>
    /** Clear transfer metadata so the idea can be edited and handed over again. */
    transferReset(ideaId: string): Promise<Idea>
  }

  inboxSpeech: {
    status(): Promise<InboxSpeechStatus>
    getSettings(): Promise<InboxSpeechSettings>
    setSettings(patch: InboxSpeechSettingsPatch): Promise<InboxSpeechSettings>
    transcribe(payload: TranscribeAudioPayload): Promise<TranscribeAudioResult>
    abort(): Promise<void>
  }

  /** Desktop-only Mission Control administration. Mobile clients use HTTP/SSE. */
  remote: {
    status(): Promise<RemoteStatus>
    enable(request: RemoteEnableRequest): Promise<RemoteStatus>
    /** Master kill switch: persistently disables remote, revokes all devices and tears down transport. */
    disable(): Promise<RemoteStatus>
    listDevices(): Promise<DeviceInfo[]>
    revokeDevice(deviceId: string): Promise<boolean>
    pairStart(request?: RemotePairStartRequest): Promise<PairingChallenge>
    onStatus(cb: (status: RemoteStatus) => void): () => void
  }

  agents: {
    list(): Promise<AgentInstanceInfo[]>
    spawn(req: SpawnAgentRequest): Promise<AgentInstanceInfo>
    /** Spawn orchestrator + all slots of a profile. */
    spawnProfile(profileId: string, yoloMaster: boolean): Promise<AgentInstanceInfo[]>
    write(id: string, data: string): void
    /** Protect a prestarted team agent after an actual user key or paste action. */
    markInteractiveUsed(id: string): void
    resize(id: string, cols: number, rows: number): void
    kill(id: string): Promise<void>
    killAll(): Promise<void>
    /** Stop all + remove panes (clean slate). */
    clean(profileId: string, workspaceSessionId?: string): Promise<void>
    /** Scrollback replay for late-mounting terminals (pop-outs, reloads). */
    buffer(id: string): Promise<AgentBufferSnapshot>
    popout(id: string): Promise<void>
    /**
     * Hand a source agent's live work over to a freshly spawned agent, seeded
     * with a handoff briefing. Returns the new (taking-over) agent.
     */
    handoff(req: HandoffRequest): Promise<AgentInstanceInfo>
    onData(cb: (chunk: AgentDataChunk) => void): () => void
    onChanged(cb: (list: AgentInstanceInfo[]) => void): () => void
    onEvent(cb: (evt: OrcaEvent) => void): () => void
  }

  orchestrator: {
    snapshot(profileId: string, workspaceSessionId?: string): Promise<OrchestratorSnapshot>
    /** Clear the task graph (fresh goal). */
    reset(profileId: string, workspaceSessionId?: string): Promise<void>
    /** Switch this running workspace session to direct automatic plan execution. */
    enableAutoMode(profileId: string, workspaceSessionId?: string): Promise<boolean>
    /** Switch this running workspace session to any planner mode (auto/review/manual). */
    setPlannerMode(
      profileId: string,
      mode: WorkspaceProfile['planner']['mode'],
      workspaceSessionId?: string
    ): Promise<boolean>
    /** Resolve a plan waiting in review mode. */
    reviewPlan(profileId: string, approved: boolean, workspaceSessionId?: string): Promise<boolean>
    onSnapshot(cb: (snap: OrchestratorSnapshot) => void): () => void
    /** Read a size-limited patch from the task's trusted Orca worktree. */
    taskDiff(profileId: string, taskId: string, workspaceSessionId?: string): Promise<TaskReviewDiff>
    approvePublication(profileId: string, workspaceSessionId: string, planId?: string): Promise<boolean>
    rejectPublication(profileId: string, workspaceSessionId: string, planId?: string): Promise<boolean>
    resolvePermission(
      profileId: string,
      workspaceSessionId: string,
      permissionId: string,
      allow: boolean
    ): Promise<boolean>
    setBudgetCaps(
      profileId: string,
      workspaceSessionId: string,
      caps: RemoteBudgetCaps
    ): Promise<RemoteBudgetSnapshot>
    pauseTask(profileId: string, workspaceSessionId: string, taskId: string): Promise<boolean>
    resumeTask(profileId: string, workspaceSessionId: string, taskId: string): Promise<boolean>
    fallbackTask(profileId: string, workspaceSessionId: string, taskId: string): Promise<boolean>
  }

  retro: {
    /** Retrospectives of past runs, newest first (optionally per profile). */
    listRetros(profileId?: string): Promise<RunRetro[]>
    /** Accumulated per-model learnings from retros, orchestrator and benchmarks. */
    listLearnings(): Promise<ModelLearning[]>
    /** Scored benchmark records, newest first (optionally per profile). */
    listBenchmarks(profileId?: string): Promise<BenchmarkRecord[]>
    /** Current retro-sync state: config, queue length, last export/error. */
    syncStatus(): Promise<RetroSyncStatus>
    /** Drain the export queue now; returns the resulting sync status. */
    syncFlush(): Promise<RetroSyncStatus>
  }

  win: {
    minimize(): void
    maximizeToggle(): void
    close(): void
  }
}
