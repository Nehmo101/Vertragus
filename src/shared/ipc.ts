/**
 * IPC channel names and the typed API surface exposed to the renderer via preload.
 * Keeping these in one shared module keeps main <-> preload <-> renderer in sync.
 */
import type { AgentProviderId, ProviderHealth, ProviderId } from './providers'
import type { WorkspaceProfile } from './profile'
import type {
  AgentBufferSnapshot,
  AgentDataChunk,
  AgentInstanceInfo,
  HandoffRequest,
  OrcaEvent,
  SpawnAgentRequest
} from './agents'
import type { OrchestratorSnapshot } from './orchestrator'

export const IPC = {
  appInfo: 'app:info',
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
  gitInfo: 'git:info',
  githubProjects: 'github:projects',
  dialogPickFolder: 'dialog:pickFolder',
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

/**
 * The API bridged onto `window.orca` in the renderer. Every method maps 1:1
 * onto an ipcMain handler (or push channel) registered in the main process.
 */
export interface OrcaApi {
  getAppInfo(): Promise<AppInfo>
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

  gitInfo(dir: string): Promise<GitInfo>
  /** List GitHub Projects boards for the explicit owner or the workspace origin owner. */
  githubProjects(dir: string, owner?: string): Promise<GithubProjectsResult>
  /** Open a native folder picker; resolves to the chosen path or null. */
  pickFolder(): Promise<string | null>

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
