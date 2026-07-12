/**
 * IPC channel names and the typed API surface exposed to the renderer via preload.
 * Keeping these in one shared module keeps main <-> preload <-> renderer in sync.
 */
import type { AgentProviderId, ProviderHealth, ProviderId } from './providers'
import type { ProfileCloneStatus, ProfileGithubRepo, WorkspaceProfile } from './profile'
import type { McpServerConfig } from './mcp'
import type {
  AgentBufferSnapshot,
  AgentDataChunk,
  AgentInstanceInfo,
  HandoffRequest,
  OrcaEvent,
  SpawnAgentRequest
} from './agents'
import type { OrchestratorSnapshot } from './orchestrator'
import type {
  AddArtifactInput,
  CreateIdeaInput,
  Idea,
  IdeaTransferRequest,
  IdeaTransferResult,
  UpdateIdeaInput
} from './inbox'
import type {
  InboxSpeechSettings,
  InboxSpeechSettingsPatch,
  InboxSpeechStatus,
  TranscribeAudioPayload,
  TranscribeAudioResult
} from './inboxSpeech'

export const IPC = {
  appInfo: 'app:info',
  appUpdateState: 'app:updateState',
  appUpdateCheck: 'app:updateCheck',
  appUpdateDownload: 'app:updateDownload',
  appUpdateInstall: 'app:updateInstall',
  providersHealth: 'providers:health',
  providersModels: 'providers:models',
  providerLogin: 'providers:login',
  configGet: 'config:get',
  configSet: 'config:set',
  profilesList: 'profiles:list',
  profileSave: 'profile:save',
  profileDelete: 'profile:delete',
  profileGetActive: 'profiles:getActive',
  profileSetActive: 'profiles:setActive',
  mcpList: 'mcp:list',
  mcpSave: 'mcp:save',
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
  ideasTransferToProfile: 'ideas:transferToProfile',
  ideasTransferRetry: 'ideas:transferRetry',
  inboxSpeechStatus: 'inboxSpeech:status',
  inboxSpeechGetSettings: 'inboxSpeech:getSettings',
  inboxSpeechSetSettings: 'inboxSpeech:setSettings',
  inboxSpeechTranscribe: 'inboxSpeech:transcribe',
  inboxSpeechAbort: 'inboxSpeech:abort',
  agentsList: 'agents:list',
  agentSpawn: 'agent:spawn',
  agentsSpawnProfile: 'agents:spawnProfile',
  agentWrite: 'agent:write',
  agentResize: 'agent:resize',
  agentKill: 'agent:kill',
  agentsKillAll: 'agents:killAll',
  agentsClean: 'agents:clean',
  agentBuffer: 'agent:buffer',
  agentPopout: 'agent:popout',
  agentHandoff: 'agent:handoff',
  orchestratorSnapshot: 'orchestrator:snapshot',
  orchestratorReset: 'orchestrator:reset',
  orchestratorReviewPlan: 'orchestrator:reviewPlan',
  // main -> renderer push channels
  evAgentData: 'ev:agentData',
  evAgentsChanged: 'ev:agentsChanged',
  evOrcaEvent: 'ev:orcaEvent',
  evProvidersHealth: 'ev:providersHealth',
  evAppUpdateState: 'ev:appUpdateState',
  evOrchestrator: 'ev:orchestrator',
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

export interface GitInfo {
  isRepo: boolean
  root?: string
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
  /** Probe every provider CLI/integration for availability + version. */
  checkProviders(): Promise<ProviderHealth[]>
  /** Model options per agent provider (ollama live when reachable). */
  /** Open the provider's official CLI login flow in an interactive Orca terminal. */
  loginProvider(id: ProviderId): Promise<AgentInstanceInfo>
  /** Receive refreshed connection state after an interactive login exits. */
  onProvidersChanged(cb: (health: ProviderHealth[]) => void): () => void
  listModels(): Promise<Record<AgentProviderId, string[]>>
  getConfig<T = unknown>(key: string): Promise<T | undefined>
  setConfig(key: string, value: unknown): Promise<void>

  listProfiles(): Promise<WorkspaceProfile[]>
  saveProfile(profile: WorkspaceProfile): Promise<WorkspaceProfile[]>
  deleteProfile(id: string): Promise<WorkspaceProfile[]>
  getActiveProfileId(): Promise<string>
  setActiveProfileId(id: string): Promise<void>

  /** External MCP servers attached to the launched agents. */
  listMcpServers(): Promise<McpServerConfig[]>
  /** Validate + persist the full MCP server list; returns the stored result. */
  saveMcpServers(servers: McpServerConfig[]): Promise<McpServerConfig[]>

  gitInfo(dir: string): Promise<GitInfo>
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
  /** Open a native file picker for inbox artifacts; resolves to path or null. */
  pickFile(): Promise<string | null>

  inbox: {
    list(): Promise<Idea[]>
    get(id: string): Promise<Idea | undefined>
    create(input?: CreateIdeaInput): Promise<Idea>
    update(input: UpdateIdeaInput): Promise<Idea>
    delete(id: string): Promise<Idea[]>
    addArtifact(ideaId: string, input: AddArtifactInput): Promise<Idea>
    removeArtifact(ideaId: string, artifactId: string): Promise<Idea>
    /** Hand idea + artifacts to a workspace profile and start orchestrator planning. */
    transferToProfile(req: IdeaTransferRequest): Promise<IdeaTransferResult>
    /** Retry a failed, retryable transfer for the same profile. */
    transferRetry(ideaId: string, yoloMaster?: boolean): Promise<IdeaTransferResult>
  }

  inboxSpeech: {
    status(): Promise<InboxSpeechStatus>
    getSettings(): Promise<InboxSpeechSettings>
    setSettings(patch: InboxSpeechSettingsPatch): Promise<InboxSpeechSettings>
    transcribe(payload: TranscribeAudioPayload): Promise<TranscribeAudioResult>
    abort(): Promise<void>
  }

  agents: {
    list(): Promise<AgentInstanceInfo[]>
    spawn(req: SpawnAgentRequest): Promise<AgentInstanceInfo>
    /** Spawn orchestrator + all slots of a profile. */
    spawnProfile(profileId: string, yoloMaster: boolean): Promise<AgentInstanceInfo[]>
    write(id: string, data: string): void
    resize(id: string, cols: number, rows: number): void
    kill(id: string): Promise<void>
    killAll(): Promise<void>
    /** Stop all + remove panes (clean slate). */
    clean(): Promise<void>
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
    snapshot(): Promise<OrchestratorSnapshot>
    /** Clear the task graph (fresh goal). */
    reset(): Promise<void>
    /** Resolve a plan waiting in review mode. */
    reviewPlan(approved: boolean): Promise<boolean>
    onSnapshot(cb: (snap: OrchestratorSnapshot) => void): () => void
  }

  win: {
    minimize(): void
    maximizeToggle(): void
    close(): void
  }
}
