import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { IPC, type UpdateState, type VertragusApi } from '@shared/ipc'
import { assertValidConfigKey } from '@shared/ipcValidation'
import type { AgentDataChunk, AgentInstanceInfo, VertragusEvent } from '@shared/agents'
import type { OrchestratorSnapshot, WorkspaceSessionSummary } from '@shared/orchestrator'
import type { ProviderHealth } from '@shared/providers'
import type { VoiceAssistantProgressEvent, VoiceUiCommand } from '@shared/voiceAssistant'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const vertragus: VertragusApi = {
  getAppInfo: () => ipcRenderer.invoke(IPC.appInfo),
  updates: {
    state: () => ipcRenderer.invoke(IPC.appUpdateState),
    check: () => ipcRenderer.invoke(IPC.appUpdateCheck),
    download: () => ipcRenderer.invoke(IPC.appUpdateDownload),
    install: () => ipcRenderer.invoke(IPC.appUpdateInstall),
    onState: (cb) => subscribe<UpdateState>(IPC.evAppUpdateState, cb)
  },
  diagnostics: {
    exportLatest: (profileId) => ipcRenderer.invoke(IPC.diagnosticsExportLatest, profileId)
  },
  checkProviders: () => ipcRenderer.invoke(IPC.providersHealth),
  getProviderCapacity: () => ipcRenderer.invoke(IPC.providersCapacity),
  loginProvider: (id) => ipcRenderer.invoke(IPC.providerLogin, id),
  onProvidersChanged: (cb) => subscribe<ProviderHealth[]>(IPC.evProvidersHealth, cb),
  listModels: () => ipcRenderer.invoke(IPC.providersModels),
  getConfig: (key) => ipcRenderer.invoke(IPC.configGet, assertValidConfigKey(key)),
  setConfig: (key, value) => ipcRenderer.invoke(IPC.configSet, assertValidConfigKey(key), value),

  listProfiles: () => ipcRenderer.invoke(IPC.profilesList),
  saveProfile: (profile) => ipcRenderer.invoke(IPC.profileSave, profile),
  deleteProfile: (id) => ipcRenderer.invoke(IPC.profileDelete, id),
  generateProfileForRepo: (req) => ipcRenderer.invoke(IPC.profileGenerateForRepo, req),
  getActiveProfileId: () => ipcRenderer.invoke(IPC.profileGetActive),
  setActiveProfileId: (id) => ipcRenderer.invoke(IPC.profileSetActive, id),
  workspaceSessions: {
    list: (profileId) => ipcRenderer.invoke(IPC.workspaceSessionsList, profileId),
    setActive: (profileId, sessionId) =>
      ipcRenderer.invoke(IPC.workspaceSessionSetActive, profileId, sessionId),
    remove: (profileId, sessionId) =>
      ipcRenderer.invoke(IPC.workspaceSessionRemove, profileId, sessionId),
    onChanged: (cb) => subscribe<WorkspaceSessionSummary[]>(IPC.evWorkspaceSessions, cb)
  },

  listMcpServers: () => ipcRenderer.invoke(IPC.mcpList),
  saveMcpServers: (servers) => ipcRenderer.invoke(IPC.mcpSave, servers),

  gitSwitchBranch: (dir, branch) => ipcRenderer.invoke(IPC.gitSwitchBranch, dir, branch),
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
  pickFile: () => ipcRenderer.invoke(IPC.dialogPickFile),
  files: {
    pathForFile: (file) => webUtils.getPathForFile(file)
  },
  demo: {
    play: () => ipcRenderer.invoke(IPC.demoPlay)
  },

  inbox: {
    list: () => ipcRenderer.invoke(IPC.ideasList),
    get: (id) => ipcRenderer.invoke(IPC.ideasGet, id),
    create: (input) => ipcRenderer.invoke(IPC.ideasCreate, input),
    update: (input) => ipcRenderer.invoke(IPC.ideasUpdate, input),
    delete: (id) => ipcRenderer.invoke(IPC.ideasDelete, id),
    addArtifact: (ideaId, input) => ipcRenderer.invoke(IPC.ideasAddArtifact, ideaId, input),
    removeArtifact: (ideaId, artifactId) =>
      ipcRenderer.invoke(IPC.ideasRemoveArtifact, ideaId, artifactId),
    removeAttribute: (ideaId, attribute) =>
      ipcRenderer.invoke(IPC.ideasRemoveAttribute, ideaId, attribute),
    restoreIdea: (ideaId) => ipcRenderer.invoke(IPC.ideasRestore, ideaId),
    transferToProfile: (req) => ipcRenderer.invoke(IPC.ideasTransferToProfile, req),
    transferRetry: (ideaId, yoloMaster) =>
      ipcRenderer.invoke(IPC.ideasTransferRetry, ideaId, yoloMaster),
    enhancePrompt: (req) => ipcRenderer.invoke(IPC.ideasEnhancePrompt, req),
    abortPromptEnhancement: (requestId) =>
      ipcRenderer.invoke(IPC.ideasAbortPromptEnhancement, { requestId }),
    transferReset: (ideaId) => ipcRenderer.invoke(IPC.ideasTransferReset, ideaId)
  },

  inboxSpeech: {
    status: () => ipcRenderer.invoke(IPC.inboxSpeechStatus),
    getSettings: () => ipcRenderer.invoke(IPC.inboxSpeechGetSettings),
    setSettings: (patch) => ipcRenderer.invoke(IPC.inboxSpeechSetSettings, patch),
    transcribe: (payload) => ipcRenderer.invoke(IPC.inboxSpeechTranscribe, payload),
    abort: () => ipcRenderer.invoke(IPC.inboxSpeechAbort)
  },

  remote: {
    status: () => ipcRenderer.invoke(IPC.remoteStatus),
    enable: (request) => ipcRenderer.invoke(IPC.remoteEnable, request),
    disable: () => ipcRenderer.invoke(IPC.remoteDisable),
    listDevices: () => ipcRenderer.invoke(IPC.remoteListDevices),
    revokeDevice: (deviceId) => ipcRenderer.invoke(IPC.remoteRevokeDevice, deviceId),
    pairStart: (request) => ipcRenderer.invoke(IPC.remotePairStart, request),
    onStatus: (cb) => subscribe(IPC.evRemote, cb)
  },

  agents: {
    list: () => ipcRenderer.invoke(IPC.agentsList),
    spawn: (req) => ipcRenderer.invoke(IPC.agentSpawn, req),
    spawnProfile: (profileId, yoloMaster) =>
      ipcRenderer.invoke(IPC.agentsSpawnProfile, profileId, yoloMaster),
    write: (id, data) => ipcRenderer.send(IPC.agentWrite, id, data),
    markInteractiveUsed: (id) => ipcRenderer.send(IPC.agentMarkInteractiveUsed, id),
    resize: (id, cols, rows) => ipcRenderer.send(IPC.agentResize, id, cols, rows),
    kill: (id) => ipcRenderer.invoke(IPC.agentKill, id),
    killAll: () => ipcRenderer.invoke(IPC.agentsKillAll),
    clean: (profileId, workspaceSessionId) =>
      ipcRenderer.invoke(IPC.agentsClean, profileId, workspaceSessionId),
    buffer: (id) => ipcRenderer.invoke(IPC.agentBuffer, id),
    popout: (id) => ipcRenderer.invoke(IPC.agentPopout, id),
    handoff: (req) => ipcRenderer.invoke(IPC.agentHandoff, req),
    bulkHandoff: (req) => ipcRenderer.invoke(IPC.agentsBulkHandoff, req),
    onData: (cb) => subscribe<AgentDataChunk>(IPC.evAgentData, cb),
    onChanged: (cb) => subscribe<AgentInstanceInfo[]>(IPC.evAgentsChanged, cb),
    onEvent: (cb) => subscribe<VertragusEvent>(IPC.evOrcaEvent, cb)
  },

  orchestrator: {
    snapshot: (profileId, workspaceSessionId) =>
      ipcRenderer.invoke(IPC.orchestratorSnapshot, profileId, workspaceSessionId),
    reset: (profileId, workspaceSessionId) =>
      ipcRenderer.invoke(IPC.orchestratorReset, profileId, workspaceSessionId),
    enableAutoMode: (profileId, workspaceSessionId) =>
      ipcRenderer.invoke(IPC.orchestratorEnableAutoMode, profileId, workspaceSessionId),
    setPlannerMode: (profileId, mode, workspaceSessionId) =>
      ipcRenderer.invoke(IPC.orchestratorSetPlannerMode, profileId, mode, workspaceSessionId),
    setYoloMaster: (enabled) =>
      ipcRenderer.invoke(IPC.orchestratorSetYoloMaster, enabled),
    reviewPlan: (profileId, approved, workspaceSessionId) =>
      ipcRenderer.invoke(IPC.orchestratorReviewPlan, profileId, approved, workspaceSessionId),
    taskDiff: (profileId, taskId, workspaceSessionId) =>
      ipcRenderer.invoke(IPC.orchestratorTaskDiff, profileId, taskId, workspaceSessionId),
    approvePublication: (profileId, workspaceSessionId, planId) =>
      ipcRenderer.invoke(IPC.orchestratorApprovePublication, profileId, workspaceSessionId, planId),
    rejectPublication: (profileId, workspaceSessionId, planId) =>
      ipcRenderer.invoke(IPC.orchestratorRejectPublication, profileId, workspaceSessionId, planId),
    resolvePermission: (profileId, workspaceSessionId, permissionId, allow) =>
      ipcRenderer.invoke(
        IPC.orchestratorResolvePermission,
        profileId,
        workspaceSessionId,
        permissionId,
        allow
      ),
    setBudgetCaps: (profileId, workspaceSessionId, caps) =>
      ipcRenderer.invoke(IPC.orchestratorSetBudgetCaps, profileId, workspaceSessionId, caps),
    pauseTask: (profileId, workspaceSessionId, taskId) =>
      ipcRenderer.invoke(IPC.orchestratorPauseTask, profileId, workspaceSessionId, taskId),
    resumeTask: (profileId, workspaceSessionId, taskId) =>
      ipcRenderer.invoke(IPC.orchestratorResumeTask, profileId, workspaceSessionId, taskId),
    resumeInterruptedTask: (profileId, workspaceSessionId, taskId) =>
      ipcRenderer.invoke(IPC.orchestratorResumeInterruptedTask, profileId, workspaceSessionId, taskId),
    fallbackTask: (profileId, workspaceSessionId, taskId) =>
      ipcRenderer.invoke(IPC.orchestratorFallbackTask, profileId, workspaceSessionId, taskId),
    send: (profileId, workspaceSessionId, text) =>
      ipcRenderer.invoke(IPC.orchestratorSend, profileId, workspaceSessionId, text),
    onSnapshot: (cb) => subscribe<OrchestratorSnapshot>(IPC.evOrchestrator, cb)
  },

  voiceAssistant: {
    turn: (request) => ipcRenderer.invoke(IPC.voiceAssistantTurn, request),
    onProgress: (cb) => subscribe<VoiceAssistantProgressEvent>(IPC.evVoiceAssistant, cb),
    getSettings: () => ipcRenderer.invoke(IPC.voiceAssistantGetSettings),
    setSettings: (patch) => ipcRenderer.invoke(IPC.voiceAssistantSetSettings, patch)
  },

  voiceOverlay: {
    toggle: () => ipcRenderer.invoke(IPC.voiceOverlayToggle),
    hide: () => ipcRenderer.invoke(IPC.voiceOverlayHide),
    moved: (x, y) => ipcRenderer.send(IPC.voiceOverlayMoved, x, y)
  },

  events: {
    onVoiceAssistant: (cb) => subscribe<VoiceAssistantProgressEvent>(IPC.evVoiceAssistant, cb),
    onUiCommand: (cb) => subscribe<VoiceUiCommand>(IPC.evUiCommand, cb)
  },

  retro: {
    listRetros: (profileId) => ipcRenderer.invoke(IPC.retroListRetros, profileId),
    listLearnings: () => ipcRenderer.invoke(IPC.retroListLearnings),
    listBenchmarks: (profileId) => ipcRenderer.invoke(IPC.retroListBenchmarks, profileId),
    syncStatus: () => ipcRenderer.invoke(IPC.retroSyncStatus),
    syncFlush: () => ipcRenderer.invoke(IPC.retroSyncFlush)
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
    contextBridge.exposeInMainWorld('vertragus', vertragus)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-expect-error fallback when context isolation is disabled
  window.electron = electronAPI
  // @ts-expect-error fallback when context isolation is disabled
  window.vertragus = vertragus
}
