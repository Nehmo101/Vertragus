import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { IPC, type OrcaApi, type UpdateState } from '@shared/ipc'
import type { AgentDataChunk, AgentInstanceInfo, OrcaEvent } from '@shared/agents'
import type { OrchestratorSnapshot } from '@shared/orchestrator'
import type { ProviderHealth } from '@shared/providers'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const orca: OrcaApi = {
  getAppInfo: () => ipcRenderer.invoke(IPC.appInfo),
  updates: {
    state: () => ipcRenderer.invoke(IPC.appUpdateState),
    check: () => ipcRenderer.invoke(IPC.appUpdateCheck),
    download: () => ipcRenderer.invoke(IPC.appUpdateDownload),
    install: () => ipcRenderer.invoke(IPC.appUpdateInstall),
    onState: (cb) => subscribe<UpdateState>(IPC.evAppUpdateState, cb)
  },
  checkProviders: () => ipcRenderer.invoke(IPC.providersHealth),
  loginProvider: (id) => ipcRenderer.invoke(IPC.providerLogin, id),
  onProvidersChanged: (cb) => subscribe<ProviderHealth[]>(IPC.evProvidersHealth, cb),
  listModels: () => ipcRenderer.invoke(IPC.providersModels),
  getConfig: (key) => ipcRenderer.invoke(IPC.configGet, key),
  setConfig: (key, value) => ipcRenderer.invoke(IPC.configSet, key, value),

  listProfiles: () => ipcRenderer.invoke(IPC.profilesList),
  saveProfile: (profile) => ipcRenderer.invoke(IPC.profileSave, profile),
  deleteProfile: (id) => ipcRenderer.invoke(IPC.profileDelete, id),
  getActiveProfileId: () => ipcRenderer.invoke(IPC.profileGetActive),
  setActiveProfileId: (id) => ipcRenderer.invoke(IPC.profileSetActive, id),

  listMcpServers: () => ipcRenderer.invoke(IPC.mcpList),
  saveMcpServers: (servers) => ipcRenderer.invoke(IPC.mcpSave, servers),

  gitInfo: (dir) => ipcRenderer.invoke(IPC.gitInfo, dir),
  githubProjects: (dir, owner) => ipcRenderer.invoke(IPC.githubProjects, dir, owner),
  githubAuthStatus: () => ipcRenderer.invoke(IPC.githubAuthStatus),
  githubAuthLogin: () => ipcRenderer.invoke(IPC.githubAuthLogin),
  githubAuthLogout: () => ipcRenderer.invoke(IPC.githubAuthLogout),
  githubRepoSearch: (query, limit) => ipcRenderer.invoke(IPC.githubRepoSearch, query, limit),
  githubRepoResolve: (owner, repo) => ipcRenderer.invoke(IPC.githubRepoResolve, owner, repo),
  githubRepoBind: (req) => ipcRenderer.invoke(IPC.githubRepoBind, req),
  githubRepoCheckLocal: (owner, repo, localPath) =>
    ipcRenderer.invoke(IPC.githubRepoCheckLocal, owner, repo, localPath),
  pickFolder: () => ipcRenderer.invoke(IPC.dialogPickFolder),

  agents: {
    list: () => ipcRenderer.invoke(IPC.agentsList),
    spawn: (req) => ipcRenderer.invoke(IPC.agentSpawn, req),
    spawnProfile: (profileId, yoloMaster) =>
      ipcRenderer.invoke(IPC.agentsSpawnProfile, profileId, yoloMaster),
    write: (id, data) => ipcRenderer.send(IPC.agentWrite, id, data),
    resize: (id, cols, rows) => ipcRenderer.send(IPC.agentResize, id, cols, rows),
    kill: (id) => ipcRenderer.invoke(IPC.agentKill, id),
    killAll: () => ipcRenderer.invoke(IPC.agentsKillAll),
    clean: () => ipcRenderer.invoke(IPC.agentsClean),
    buffer: (id) => ipcRenderer.invoke(IPC.agentBuffer, id),
    popout: (id) => ipcRenderer.invoke(IPC.agentPopout, id),
    handoff: (req) => ipcRenderer.invoke(IPC.agentHandoff, req),
    onData: (cb) => subscribe<AgentDataChunk>(IPC.evAgentData, cb),
    onChanged: (cb) => subscribe<AgentInstanceInfo[]>(IPC.evAgentsChanged, cb),
    onEvent: (cb) => subscribe<OrcaEvent>(IPC.evOrcaEvent, cb)
  },

  orchestrator: {
    snapshot: () => ipcRenderer.invoke(IPC.orchestratorSnapshot),
    reset: () => ipcRenderer.invoke(IPC.orchestratorReset),
    reviewPlan: (approved) => ipcRenderer.invoke(IPC.orchestratorReviewPlan, approved),
    onSnapshot: (cb) => subscribe<OrchestratorSnapshot>(IPC.evOrchestrator, cb)
  },

  win: {
    minimize: () => ipcRenderer.send(IPC.winMinimize),
    maximizeToggle: () => ipcRenderer.send(IPC.winMaximizeToggle),
    close: () => ipcRenderer.send(IPC.winClose)
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('orca', orca)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-expect-error fallback when context isolation is disabled
  window.electron = electronAPI
  // @ts-expect-error fallback when context isolation is disabled
  window.orca = orca
}
