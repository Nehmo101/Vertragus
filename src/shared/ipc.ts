/**
 * IPC channel names and the typed API surface exposed to the renderer via preload.
 * Keeping these in one shared module keeps main <-> preload <-> renderer in sync.
 */
import type { ProviderHealth } from './providers'
import type { WorkspaceProfile } from './profile'

export const IPC = {
  appInfo: 'app:info',
  providersHealth: 'providers:health',
  configGet: 'config:get',
  configSet: 'config:set',
  profilesList: 'profiles:list',
  profileSave: 'profile:save'
} as const

export interface AppInfo {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
  platform: NodeJS.Platform
}

/**
 * The API bridged onto `window.orca` in the renderer. Every method is async
 * and maps 1:1 onto an ipcMain handler in the main process.
 */
export interface OrcaApi {
  getAppInfo(): Promise<AppInfo>
  /** Probe every provider CLI/integration for availability + version. */
  checkProviders(): Promise<ProviderHealth[]>
  getConfig<T = unknown>(key: string): Promise<T | undefined>
  setConfig(key: string, value: unknown): Promise<void>
  listProfiles(): Promise<WorkspaceProfile[]>
  saveProfile(profile: WorkspaceProfile): Promise<WorkspaceProfile[]>
}
