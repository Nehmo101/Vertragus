/**
 * IPC channel names and the typed API surface exposed to the renderer via preload.
 * Keeping these in one shared module keeps main <-> preload <-> renderer in sync.
 */
import type { AgentProviderId, ProviderHealth } from './providers'
import type { WorkspaceProfile } from './profile'
import type {
  AgentBufferSnapshot,
  AgentDataChunk,
  AgentInstanceInfo,
  OrcaEvent,
  SpawnAgentRequest
} from './agents'

export const IPC = {
  appInfo: 'app:info',
  providersHealth: 'providers:health',
  providersModels: 'providers:models',
  configGet: 'config:get',
  configSet: 'config:set',
  profilesList: 'profiles:list',
  profileSave: 'profile:save',
  profileDelete: 'profile:delete',
  profileGetActive: 'profiles:getActive',
  profileSetActive: 'profiles:setActive',
  gitInfo: 'git:info',
  agentsList: 'agents:list',
  agentSpawn: 'agent:spawn',
  agentsSpawnProfile: 'agents:spawnProfile',
  agentWrite: 'agent:write',
  agentResize: 'agent:resize',
  agentKill: 'agent:kill',
  agentsKillAll: 'agents:killAll',
  agentBuffer: 'agent:buffer',
  agentPopout: 'agent:popout',
  // main -> renderer push channels
  evAgentData: 'ev:agentData',
  evAgentsChanged: 'ev:agentsChanged',
  evOrcaEvent: 'ev:orcaEvent',
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
  listModels(): Promise<Record<AgentProviderId, string[]>>
  getConfig<T = unknown>(key: string): Promise<T | undefined>
  setConfig(key: string, value: unknown): Promise<void>

  listProfiles(): Promise<WorkspaceProfile[]>
  saveProfile(profile: WorkspaceProfile): Promise<WorkspaceProfile[]>
  deleteProfile(id: string): Promise<WorkspaceProfile[]>
  getActiveProfileId(): Promise<string>
  setActiveProfileId(id: string): Promise<void>

  gitInfo(dir: string): Promise<GitInfo>

  agents: {
    list(): Promise<AgentInstanceInfo[]>
    spawn(req: SpawnAgentRequest): Promise<AgentInstanceInfo>
    /** Spawn orchestrator + all slots of a profile. */
    spawnProfile(profileId: string, yoloMaster: boolean): Promise<AgentInstanceInfo[]>
    write(id: string, data: string): void
    resize(id: string, cols: number, rows: number): void
    kill(id: string): Promise<void>
    killAll(): Promise<void>
    /** Scrollback replay for late-mounting terminals (pop-outs, reloads). */
    buffer(id: string): Promise<AgentBufferSnapshot>
    popout(id: string): Promise<void>
    onData(cb: (chunk: AgentDataChunk) => void): () => void
    onChanged(cb: (list: AgentInstanceInfo[]) => void): () => void
    onEvent(cb: (evt: OrcaEvent) => void): () => void
  }

  win: {
    minimize(): void
    maximizeToggle(): void
    close(): void
  }
}
