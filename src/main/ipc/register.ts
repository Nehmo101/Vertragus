/**
 * Registers all ipcMain handlers. Each maps 1:1 onto a method in OrcaApi
 * (src/shared/ipc.ts) which the preload bridge exposes on window.orca.
 */
import { app, dialog, ipcMain, BrowserWindow } from 'electron'
import { stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { IPC, type AppInfo } from '@shared/ipc'
import type { HandoffRequest, OrcaEvent, SpawnAgentRequest } from '@shared/agents'
import type { OrchestratorSnapshot } from '@shared/orchestrator'
import type { ProviderId } from '@shared/providers'
import {
  profileRepoLocalPath,
  type RepoProfileGenerationRequest,
  type WorkspaceProfile
} from '@shared/profile'
import type { McpServerConfig } from '@shared/mcp'
import type { GithubRepoBindRequest } from '@shared/ipc'
import { checkAllProviders } from '@main/providers/health'
import { listModels } from '@main/providers/models'
import { gitInfo, switchBranch } from '@main/integrations/git'
import { listGithubProjects } from '@main/integrations/github'
import {
  checkForMainUpdate,
  downloadMainUpdate,
  getUpdateState,
  installMainUpdate,
  onUpdateState
} from '@main/updater'
import {
  githubAuthLogin,
  githubAuthLogout,
  githubAuthStatus
} from '@main/integrations/githubAuth'
import {
  bindGithubRepo,
  checkGithubRepoLocal,
  resolveGithubRepo,
  searchGithubRepos
} from '@main/integrations/githubRepo'
import { agentManager } from '@main/agents/AgentManager'
import { providerCapacity } from '@main/agents/providerCapacity'
import { workspaceSessions } from '@main/orchestrator/WorkspaceSessionRegistry'
import { broadcast, createPaneWindow, isMainWindowSender } from '@main/windows'
import { getPublicConfig, setPublicConfig } from '@main/config/configAccess'
import {
  listProfiles,
  saveProfile,
  deleteProfile,
  getProfile,
  getActiveProfileId,
  setActiveProfileId,
  listMcpServers,
  saveMcpServers
} from '@main/config/store'
import { issuePickerGrant } from '@main/inbox/pickerGrants'
import { resolveGithubLocalPathOptional } from '@main/security/localPath'
import {
  listIdeas,
  getIdea,
  createIdea,
  updateIdea,
  deleteIdea,
  addArtifact,
  removeArtifact,
  resetIdeaTransfer
} from '@main/inbox/store'
import { retryIdeaTransfer, transferIdeaToProfile } from '@main/inbox/transferService'
import { spawnProfileTeam } from '@main/agents/spawnProfile'
import { getActiveRepoOverridePath } from '@main/config/workspaceRepo'
import { generateProfileForRepo } from '@main/profiles/generateProfileForRepo'
import { createProfileDeletionIpcController } from '@main/profiles/profileDeletionIpc'
import {
  listBenchmarkRecords,
  listModelLearnings,
  listRunRetros
} from '@main/orchestrator/retroStore'
import { flushRetroExportQueue, retroSyncStatus } from '@main/orchestrator/retroExport'
import type {
  AddArtifactInput,
  CreateIdeaInput,
  UpdateIdeaInput
} from '@shared/inbox'
import type { IdeaTransferRequest } from '@shared/inboxTransfer'
import type { InboxSpeechSettingsPatch, TranscribeAudioPayload } from '@shared/inboxSpeech'
import {
  abortInboxTranscription,
  getInboxSpeechSettings,
  getInboxSpeechStatus,
  setInboxSpeechSettings,
  transcribeInboxAudio
} from '@main/voice/InboxSpeechService'
import { RunJournal } from '@main/diagnostics/runJournal'
import { loadTaskReviewDiff } from '@main/integrations/reviewDiff'
import { createMainPromptEnhancementService } from '@main/inbox/promptEnhancementProvider'
import { inspectPromptWorkspaceContext } from '@main/inbox/promptEnhancementContext'
import {
  assertAuthorizedPromptEnhancementSender,
  createPromptEnhancementIpcController,
  type PromptIpcWebContentsLike
} from '@main/inbox/promptEnhancementIpc'

function senderWindow(e: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(e.sender)
}

async function saveRunDialog(
  win: BrowserWindow | null,
  defaultPath: string
): Promise<Electron.SaveDialogReturnValue> {
  const options: Electron.SaveDialogOptions = {
    title: 'Redigierte Orca-Diagnose exportieren',
    defaultPath,
    filters: [{ name: 'JSON Lines', extensions: ['jsonl'] }]
  }
  return win ? dialog.showSaveDialog(win, options) : dialog.showSaveDialog(options)
}


function recordDiagnostic(
  journal: RunJournal,
  record: Parameters<RunJournal['record']>[0]
): void {
  try {
    journal.record(record)
  } catch (error) {
    console.warn('[Diagnostics] run journal write failed', error)
  }
}
async function normalizeDirectory(raw: string, label: string): Promise<string> {
  const directory = resolve(raw.trim())
  try {
    const info = await stat(directory)
    if (!info.isDirectory()) throw new Error('Pfad ist kein Verzeichnis.')
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`${label} ist nicht zugreifbar: ${directory} (${detail})`)
  }
  return directory
}

export function registerIpcHandlers(): void {
  providerCapacity.refreshLimits()

  const runJournal = new RunJournal(join(app.getPath('userData'), 'diagnostics', 'runs'))
  const promptService = createMainPromptEnhancementService()
  const promptController = createPromptEnhancementIpcController({
    authorize: (event) =>
      assertAuthorizedPromptEnhancementSender(event, {
        developmentUrl: process.env['ELECTRON_RENDERER_URL'],
        packagedRendererUrl: pathToFileURL(join(__dirname, '../renderer/index.html')).toString(),
        isKnownSender: (sender: PromptIpcWebContentsLike) =>
          Boolean(BrowserWindow.fromWebContents(sender as Electron.WebContents))
      }),
    getProfile,
    inspectWorkspace: inspectPromptWorkspaceContext,
    service: promptService
  })
  const profileDeletionController = createProfileDeletionIpcController({
    authorization: {
      developmentUrl: process.env['ELECTRON_RENDERER_URL'],
      packagedRendererUrl: pathToFileURL(join(__dirname, '../renderer/index.html')).toString(),
      isKnownSender: (sender) => isMainWindowSender(sender as Electron.WebContents)
    },
    deleteProfile: (id) => {
      if (!getProfile(id)) throw new Error('Workspace-Profil nicht gefunden.')
      if (agentManager.anyRunning(id)) {
        throw new Error('Profil löschen ist während einer laufenden Agent-Session gesperrt.')
      }
      const profiles = deleteProfile(id)
      workspaceSessions.remove(id)
      return profiles
    }
  })
  // ---- app / providers / config ----
  ipcMain.handle(IPC.appInfo, (): AppInfo => {
    return {
      name: app.getName(),
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform
    }
  })
  ipcMain.handle(IPC.appUpdateState, () => getUpdateState())
  ipcMain.handle(IPC.appUpdateCheck, () => checkForMainUpdate())
  ipcMain.handle(IPC.appUpdateDownload, () => downloadMainUpdate())
  ipcMain.handle(IPC.appUpdateInstall, () => installMainUpdate())
  ipcMain.handle(IPC.providersHealth, () => checkAllProviders())
  ipcMain.handle(IPC.providersCapacity, () => providerCapacity.statsAll())
  ipcMain.handle(IPC.diagnosticsExportLatest, async (e, profileId: string) => {
    const latest = runJournal.list(String(profileId ?? ''))[0]
    if (!latest) return null
    const result = await saveRunDialog(
      senderWindow(e),
      `orca-run-${latest.runId}-${new Date(latest.updatedAt).toISOString().slice(0, 10)}.jsonl`
    )
    if (result.canceled || !result.filePath) return null
    runJournal.export(latest.runId, result.filePath)
    return result.filePath
  })
  ipcMain.handle(IPC.providerLogin, async (_e, id: ProviderId) => {
    const info = await agentManager.loginProvider(id)
    createPaneWindow(info.id)
    return info
  })
  ipcMain.handle(IPC.providersModels, () => listModels())
  ipcMain.handle(IPC.configGet, (_e, key: string) => getPublicConfig(key))
  ipcMain.handle(IPC.configSet, (_e, key: string, value: unknown) => {
    setPublicConfig(key, value)
    if (key === 'providerLimits') providerCapacity.refreshLimits()
  })

  // ---- profiles ----
  ipcMain.handle(IPC.profilesList, () => listProfiles())
  ipcMain.handle(IPC.profileSave, async (_e, profile: WorkspaceProfile) => {
    let workingDir = profile.workingDir.trim()
    let githubRepo = profile.githubRepo

    if (githubRepo) {
      const localPath = resolveGithubLocalPathOptional(githubRepo.localPath, 'Repository')
      if (localPath) {
        workingDir = await normalizeDirectory(localPath, 'Repository')
        if (githubRepo.owner && githubRepo.repo) {
          const check = await checkGithubRepoLocal(githubRepo.owner, githubRepo.repo, workingDir)
          githubRepo = { ...githubRepo, localPath: workingDir, cloneStatus: check.cloneStatus }
          if (check.cloneStatus === 'diverged') {
            throw new Error(check.message)
          }
        } else {
          githubRepo = { ...githubRepo, localPath: workingDir }
        }
      } else if (workingDir) {
        workingDir = await normalizeDirectory(workingDir, 'Workspace')
        githubRepo = { ...githubRepo, localPath: workingDir }
        if (githubRepo.owner && githubRepo.repo) {
          const check = await checkGithubRepoLocal(githubRepo.owner, githubRepo.repo, workingDir)
          githubRepo = { ...githubRepo, cloneStatus: check.cloneStatus }
          if (check.cloneStatus === 'diverged') {
            throw new Error(check.message)
          }
        }
      }
    } else if (workingDir) {
      workingDir = await normalizeDirectory(workingDir, 'Workspace')
    }

    const agents = await Promise.all(
      profile.agents.map(async (slot, index) => ({
        ...slot,
        workingDir: slot.workingDir?.trim()
          ? await normalizeDirectory(slot.workingDir, `Pfad für Slot ${index + 1}`)
          : undefined
      }))
    )
    const effectiveWorkingDir = profileRepoLocalPath({ workingDir, githubRepo }) || workingDir
    return saveProfile({ ...profile, workingDir: effectiveWorkingDir, githubRepo, agents })
  })
  ipcMain.handle(IPC.profileGenerateForRepo, (_e, req: RepoProfileGenerationRequest) =>
    generateProfileForRepo(req)
  )
  ipcMain.handle(IPC.profileDelete, (e, id: unknown) =>
    profileDeletionController.delete(e, id)
  )
  ipcMain.handle(IPC.profileGetActive, () => getActiveProfileId())
  ipcMain.handle(IPC.profileSetActive, (_e, id: string) => {
    if (!getProfile(id)) {
      throw new Error('Workspace-Profil nicht gefunden.')
    }
    setActiveProfileId(id)
  })
  ipcMain.handle(IPC.workspaceSessionsList, (_e, profileId?: string) =>
    workspaceSessions.list(profileId)
  )
  ipcMain.handle(IPC.workspaceSessionSetActive, (_e, profileId: string, sessionId: string) => {
    const profile = getProfile(profileId)
    if (!profile) throw new Error('Workspace-Profil nicht gefunden.')
    return workspaceSessions.setActive(profileId, sessionId).engine.snapshot()
  })
  ipcMain.handle(IPC.workspaceSessionRemove, async (_e, profileId: string, sessionId: string) => {
    await agentManager.removeAll(profileId, sessionId)
    workspaceSessions.removeSession(sessionId)
    return workspaceSessions.list(profileId)
  })

  // ---- external MCP servers ----
  ipcMain.handle(IPC.mcpList, () => listMcpServers())
  ipcMain.handle(IPC.mcpSave, (_e, servers: McpServerConfig[]) => saveMcpServers(servers))

  // ---- git ----
  ipcMain.handle(IPC.gitSwitchBranch, (_e, dir: string, branch: string) =>
    switchBranch(dir, branch)
  )
  ipcMain.handle(IPC.gitInfo, (_e, dir: string) => gitInfo(dir))
  ipcMain.handle(IPC.githubProjects, (_e, dir: string, owner?: string) =>
    listGithubProjects(dir, owner)
  )
  ipcMain.handle(IPC.githubAuthStatus, () => githubAuthStatus())
  ipcMain.handle(IPC.githubAuthLogin, async () => {
    const status = await githubAuthLogin({
      useTerminalLogin: async () => {
        const info = await agentManager.loginProvider('github')
        createPaneWindow(info.id)
      }
    })
    void checkAllProviders()
      .then((health) => broadcast(IPC.evProvidersHealth, health))
      .catch((error) => console.warn('[GitHub] refresh after login failed', error))
    return status
  })
  ipcMain.handle(IPC.githubAuthLogout, async () => {
    const status = await githubAuthLogout()
    void checkAllProviders()
      .then((health) => broadcast(IPC.evProvidersHealth, health))
      .catch((error) => console.warn('[GitHub] refresh after logout failed', error))
    return status
  })
  ipcMain.handle(IPC.githubRepoSearch, (_e, query: string, limit?: number) =>
    searchGithubRepos(query, limit)
  )
  ipcMain.handle(IPC.githubRepoResolve, (_e, owner: string, repo: string) =>
    resolveGithubRepo(owner, repo)
  )
  ipcMain.handle(IPC.githubRepoBind, (_e, req: GithubRepoBindRequest) => bindGithubRepo(req))
  ipcMain.handle(IPC.githubRepoCheckLocal, (_e, owner: string, repo: string, localPath: string) =>
    checkGithubRepoLocal(owner, repo, localPath)
  )

  // ---- native folder picker ----
  ipcMain.handle(IPC.dialogPickFolder, async (e) => {
    const win = senderWindow(e)
    const opts: Electron.OpenDialogOptions = {
      title: 'Arbeitsverzeichnis / Repo wählen',
      properties: ['openDirectory', 'createDirectory']
    }
    const result = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts)
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  ipcMain.handle(IPC.dialogPickFile, async (e) => {
    const win = senderWindow(e)
    const opts: Electron.OpenDialogOptions = {
      title: 'Datei für Artefakt wählen',
      properties: ['openFile']
    }
    const result = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts)
    return result.canceled || result.filePaths.length === 0
      ? null
      : issuePickerGrant(result.filePaths[0])
  })

  // ---- ideas inbox ----
  ipcMain.handle(IPC.ideasList, () => listIdeas())
  ipcMain.handle(IPC.ideasGet, (_e, id: string) => getIdea(id))
  ipcMain.handle(IPC.ideasCreate, (_e, input?: CreateIdeaInput) => createIdea(input))
  ipcMain.handle(IPC.ideasUpdate, (_e, input: UpdateIdeaInput) => updateIdea(input))
  ipcMain.handle(IPC.ideasDelete, (_e, id: string) => deleteIdea(id))
  ipcMain.handle(IPC.ideasAddArtifact, async (_e, ideaId: string, input: AddArtifactInput) =>
    addArtifact(ideaId, input)
  )
  ipcMain.handle(IPC.ideasRemoveArtifact, (_e, ideaId: string, artifactId: string) =>
    removeArtifact(ideaId, artifactId)
  )
  ipcMain.handle(IPC.ideasTransferToProfile, (_e, req: IdeaTransferRequest) =>
    transferIdeaToProfile(req)
  )
  ipcMain.handle(IPC.ideasTransferRetry, (_e, ideaId: string, yoloMaster?: boolean) =>
    retryIdeaTransfer(ideaId, yoloMaster)
  )
  ipcMain.handle(IPC.ideasEnhancePrompt, (event, request: unknown) =>
    promptController.enhance(event, request)
  )
  ipcMain.handle(IPC.ideasAbortPromptEnhancement, (event, request: unknown) =>
    promptController.abort(event, request)
  )
  ipcMain.handle(IPC.ideasTransferReset, (_e, ideaId: string) => resetIdeaTransfer(ideaId))

  // ---- inbox speech-to-text ----
  ipcMain.handle(IPC.inboxSpeechStatus, () => getInboxSpeechStatus())
  ipcMain.handle(IPC.inboxSpeechGetSettings, () => getInboxSpeechSettings())
  ipcMain.handle(IPC.inboxSpeechSetSettings, (_e, patch: InboxSpeechSettingsPatch) =>
    setInboxSpeechSettings(patch)
  )
  ipcMain.handle(IPC.inboxSpeechTranscribe, (_e, payload: TranscribeAudioPayload) =>
    transcribeInboxAudio(payload)
  )
  ipcMain.handle(IPC.inboxSpeechAbort, () => {
    abortInboxTranscription()
  })

  // ---- agents ----
  ipcMain.handle(IPC.agentsList, () => agentManager.list())
  ipcMain.handle(IPC.agentSpawn, (_e, req: SpawnAgentRequest) => {
    if (!req.profileId) return agentManager.spawn(req)
    const profile = getProfile(req.profileId)
    if (!profile) throw new Error('Workspace-Profil nicht gefunden.')
    const session = workspaceSessions.ensure(profile)
    return agentManager.spawn({
      ...req,
      workspaceSessionId: session.id,
      engineId: session.engine.engineId
    })
  })
  ipcMain.handle(IPC.agentsSpawnProfile, async (_e, profileId: string, yoloMaster: boolean) => {
    const profile = getProfile(profileId)
    if (!profile) return []
    return spawnProfileTeam(profile, yoloMaster, {
      workingDirOverride: getActiveRepoOverridePath()
    })
  })
  ipcMain.on(IPC.agentWrite, (_e, id: string, data: string) => agentManager.write(id, data))
  ipcMain.on(IPC.agentMarkInteractiveUsed, (_e, id: string) =>
    agentManager.markInteractiveUsed(id)
  )
  ipcMain.on(IPC.agentResize, (_e, id: string, cols: number, rows: number) =>
    agentManager.resize(id, cols, rows)
  )
  ipcMain.handle(IPC.agentKill, (_e, id: string) => agentManager.kill(id))
  ipcMain.handle(IPC.agentsKillAll, () => agentManager.killAll())
  ipcMain.handle(IPC.agentsClean, async (_e, profileId: string, workspaceSessionId?: string) => {
    await agentManager.removeAll(profileId, workspaceSessionId)
    if (workspaceSessionId) workspaceSessions.removeSession(workspaceSessionId)
    else workspaceSessions.remove(profileId)
  })
  ipcMain.handle(IPC.agentBuffer, (_e, id: string) => agentManager.buffer(id))
  ipcMain.handle(IPC.agentPopout, (_e, id: string) => {
    createPaneWindow(id)
  })
  ipcMain.handle(IPC.agentHandoff, (_e, req: HandoffRequest) => agentManager.handoff(req))

  // ---- orchestrator ----
  ipcMain.handle(IPC.orchestratorSnapshot, (_e, profileId: string, workspaceSessionId?: string) => {
    const profile = getProfile(profileId)
    return profile
      ? workspaceSessions.snapshot(profile, workspaceSessionId)
      : { profileId, workspaceSessionId, goal: null, tasks: [] }
  })
  ipcMain.handle(IPC.orchestratorReset, (_e, profileId: string, workspaceSessionId?: string) => {
    const profile = getProfile(profileId)
    if (profile) workspaceSessions.reset(profile, workspaceSessionId)
  })
  ipcMain.handle(IPC.orchestratorEnableAutoMode, (_e, profileId: string, workspaceSessionId?: string) => {
    const profile = getProfile(profileId)
    return profile
      ? workspaceSessions.enableAutoMode(profile, workspaceSessionId)
      : false
  })
  ipcMain.handle(
    IPC.orchestratorSetPlannerMode,
    (_e, profileId: string, mode: WorkspaceProfile['planner']['mode'], workspaceSessionId?: string) => {
      const profile = getProfile(profileId)
      if (!profile) return false
      if (mode !== 'auto' && mode !== 'review' && mode !== 'manual') {
        throw new Error(`Unbekannter Planungsmodus: ${String(mode)}`)
      }
      return workspaceSessions.setPlannerMode(profile, mode, workspaceSessionId)
    }
  )
  ipcMain.handle(IPC.orchestratorReviewPlan, (_e, profileId: string, approved: boolean, workspaceSessionId?: string) => {
    const profile = getProfile(profileId)
    return profile
      ? workspaceSessions.reviewPlan(profile, Boolean(approved), workspaceSessionId)
      : false
  })
  ipcMain.handle(IPC.orchestratorTaskDiff, async (_e, profileId: string, taskId: string, workspaceSessionId?: string) => {
    const profile = getProfile(profileId)
    if (!profile) throw new Error('Workspace-Profil nicht gefunden.')
    const task = workspaceSessions
      .snapshot(profile, workspaceSessionId)
      .tasks.find((entry) => entry.id === taskId)
    if (!task) throw new Error('Aufgabe nicht gefunden.')
    return loadTaskReviewDiff(task)
  })

  // ---- retro / model learnings / benchmarks ----
  ipcMain.handle(IPC.retroListRetros, (_e, profileId?: string) =>
    listRunRetros(profileId ? String(profileId) : undefined)
  )
  ipcMain.handle(IPC.retroListLearnings, () => listModelLearnings())
  ipcMain.handle(IPC.retroListBenchmarks, (_e, profileId?: string) =>
    listBenchmarkRecords(profileId ? String(profileId) : undefined)
  )
  ipcMain.handle(IPC.retroSyncStatus, () => retroSyncStatus())
  ipcMain.handle(IPC.retroSyncFlush, () => flushRetroExportQueue())

  // ---- window controls (frameless title bar) ----
  ipcMain.on(IPC.winMinimize, (e) => senderWindow(e)?.minimize())
  ipcMain.on(IPC.winMaximizeToggle, (e) => {
    const win = senderWindow(e)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.on(IPC.winClose, (e) => senderWindow(e)?.close())

  // ---- push events: agent output / state / dispatch feed ----
  agentManager.on('data', (chunk) => broadcast(IPC.evAgentData, chunk))
  agentManager.on('changed', (list) => broadcast(IPC.evAgentsChanged, list))
  agentManager.on('event', (evt: OrcaEvent) => {
    recordDiagnostic(runJournal, {
      kind: 'agent-event',
      profileId: evt.profileId,
      workspaceSessionId: evt.workspaceSessionId,
      at: evt.time,
      payload: evt
    })
    broadcast(IPC.evOrcaEvent, evt)
  })
  workspaceSessions.on('changed', () => {
    broadcast(IPC.evWorkspaceSessions, workspaceSessions.list())
  })
  workspaceSessions.on('snapshot', (snap: OrchestratorSnapshot) => {
    recordDiagnostic(runJournal, {
      kind: 'orchestrator-snapshot',
      profileId: snap.profileId,
      workspaceSessionId: snap.workspaceSessionId,
      payload: snap
    })
    broadcast(IPC.evOrchestrator, snap)
  })
  agentManager.on('provider-auth-complete', () => {
    void checkAllProviders()
      .then((health) => broadcast(IPC.evProvidersHealth, health))
      .catch((error) => console.warn('[Providers] refresh after login failed', error))
  })
  onUpdateState((next) => broadcast(IPC.evAppUpdateState, next))
}
