/**
 * Registers all ipcMain handlers. Each maps 1:1 onto a method in VertragusApi
 * (src/shared/ipc.ts) which the preload bridge exposes on window.vertragus.
 */
import { app, dialog, ipcMain, BrowserWindow } from 'electron'
import { stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { IPC, type AppInfo } from '@shared/ipc'
import { assertIpcId, assertIpcOptionalId, assertValidConfigKey } from '@shared/ipcValidation'
import { parseIpcPayload } from '@main/security/ipcPayload'
import type { AgentInstanceInfo, SpawnAgentRequest, VertragusEvent } from '@shared/agents'
import {
  bulkHandoffRequestSchema,
  githubRepoBindRequestSchema,
  handoffRequestSchema,
  inboxSpeechSettingsPatchSchema,
  spawnAgentRequestSchema
} from '@shared/ipcSchemas'
import type { OrchestratorSnapshot } from '@shared/orchestrator'
import type { RemoteBudgetCaps } from '@shared/remote'
import type { ProviderId } from '@shared/providers'
import {
  profileRepoLocalPath,
  type RepoProfileGenerationRequest,
  type WorkspaceProfile
} from '@shared/profile'
import { mcpServersSchema } from '@shared/mcp'
import { checkAllProviders } from '@main/providers/health'
import { listModels } from '@main/providers/models'
import { gitInfo, switchBranch } from '@main/integrations/git'
import { listGithubProjects } from '@main/integrations/github'
import {
  checkForMainUpdate,
  downloadMainUpdate,
  getUpdateState,
  installMainUpdate,
  onUpdateState,
  setUpdateChannel
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
import * as sessionRestore from '@main/orchestrator/sessionRestore'
import { createWorkspaceSessionIpcController } from '@main/orchestrator/workspaceSessionIpc'
import {
  broadcast,
  broadcastAgentData,
  createPaneWindow,
  hideVoiceOverlay,
  isMainWindowSender,
  isVoiceWindowSender,
  moveVoiceOverlay,
  pushDemoState,
  toggleVoiceOverlay
} from '@main/windows'
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
  removeIdeaAttribute,
  restoreIdea,
  resetIdeaTransfer
} from '@main/inbox/store'
import {
  assertAuthorizedInboxArchiveSender,
  createInboxArchiveIpcController,
  type ArchiveIpcEventLike
} from '@main/inbox/archiveIpc'
import { retryIdeaTransfer, transferIdeaToProfile } from '@main/inbox/transferService'
import { spawnProfileTeam } from '@main/agents/spawnProfile'
import { getActiveRepoOverridePath } from '@main/config/workspaceRepo'
import { generateProfileForRepo } from '@main/profiles/generateProfileForRepo'
import { createProfileDeletionIpcController } from '@main/profiles/profileDeletionIpc'
import { createProfileSaveIpcController } from '@main/profiles/profileSaveIpc'
import {
  listBenchmarkRecords,
  listModelLearnings,
  listRunRetros
} from '@main/orchestrator/retroStore'
import { flushRetroExportQueue, retroSyncStatus } from '@main/orchestrator/retroExport'
import {
  addArtifactInputSchema,
  createIdeaInputSchema,
  updateIdeaInputSchema
} from '@shared/inbox'
import { ideaTransferRequestSchema } from '@shared/inboxTransfer'
import type { TranscribeAudioPayload } from '@shared/inboxSpeech'
import {
  abortInboxTranscription,
  getInboxSpeechSettings,
  getInboxSpeechStatus,
  setInboxSpeechSettings,
  transcribeInboxAudio
} from '@main/voice/InboxSpeechService'
import {
  getVoiceAssistantSettings,
  runVoiceAssistantTurn,
  setVoiceAssistantSettings
} from '@main/voice/VoiceAssistantService'
import {
  adaptVoiceTurnRequest,
  adaptVoiceTurnResult,
  guardNotVoiceWindow,
  guardOverlayControl,
  guardVoiceTurnAllowed,
  resolveOrchestratorSend
} from '@main/voice/voiceIpc'
import type {
  OrchestratorSendResult,
  VoiceAssistantProgressEvent,
  VoiceAssistantSettingsPatch,
  VoiceOverlayTurnRequest,
  VoiceOverlayTurnResult
} from '@shared/voiceAssistant'
import { RunJournal } from '@main/diagnostics/runJournal'
import { loadTaskReviewDiff } from '@main/integrations/reviewDiff'
import { createMainPromptEnhancementService } from '@main/inbox/promptEnhancementProvider'
import { inspectPromptWorkspaceContext } from '@main/inbox/promptEnhancementContext'
import {
  assertAuthorizedPromptEnhancementSender,
  createPromptEnhancementIpcController,
  type PromptIpcWebContentsLike
} from '@main/inbox/promptEnhancementIpc'
import { remoteService } from '@main/remote'
import type { RemoteEnableRequest, RemotePairStartRequest } from '@shared/remote'
import { createAttentionIpcController } from '@main/attention/attentionIpc'

function senderWindow(e: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(e.sender)
}

async function saveRunDialog(
  win: BrowserWindow | null,
  defaultPath: string
): Promise<Electron.SaveDialogReturnValue> {
  const options: Electron.SaveDialogOptions = {
    title: 'Redigierte Vertragus-Diagnose exportieren',
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

// Consistent handling for a profileId that resolves to no profile. Mutations
// throw (a deleted-profile race is a real error the renderer can surface),
// distinguishing it from a legitimate false/decline returned by the engine; the
// read-only snapshot handler stays lenient. Mirrors the remote path's requireProfile.
function requireProfile(profileId: unknown): WorkspaceProfile {
  const profile = getProfile(assertIpcId(profileId, 'Profil-ID'))
  if (!profile) throw new Error('Workspace-Profil nicht gefunden.')
  return profile
}

// Orchestrator snapshots are emitted up to ~1/s per running task, dominated by
// output/usage ticks that do not change task state. Journaling every one meant a
// full recursive redaction walk + write per tick. Instead journal only when the
// meaningful state actually transitions (task set/status, pending plan/approvals/
// permissions, budget-exceeded), which is all the run history needs to capture.
function orchestratorSnapshotSignature(snap: OrchestratorSnapshot): string {
  const tasks = (snap.tasks ?? []).map((task) => `${task.id}:${task.status}`).join(',')
  return [
    tasks,
    `plan:${snap.pendingPlan?.planId ?? ''}:${snap.pendingPlan?.rejected ?? ''}`,
    `appr:${snap.pendingApprovals?.length ?? 0}`,
    `perm:${(snap.pendingPermissions ?? []).map((p) => p.id).join('+')}`,
    `budget:${snap.budget?.exceeded ?? false}`,
    `goal:${snap.goal ? 'set' : 'none'}`
  ].join('|')
}
const lastJournaledSnapshotSig = new Map<string, string>()
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
  const rendererAuthorization = {
    developmentUrl: process.env['ELECTRON_RENDERER_URL'],
    packagedRendererUrl: pathToFileURL(join(__dirname, '../renderer/index.html')).toString(),
    isKnownSender: (sender: import('@main/security/ipcAuthorization').RendererIpcWebContentsLike) =>
      isMainWindowSender(sender as Electron.WebContents)
  }
  const profileDeletionController = createProfileDeletionIpcController({
    authorization: rendererAuthorization,
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
  const inboxArchiveController = createInboxArchiveIpcController({
    authorize: (event) =>
      assertAuthorizedInboxArchiveSender(event, {
        developmentUrl: process.env['ELECTRON_RENDERER_URL'],
        packagedRendererUrl: pathToFileURL(join(__dirname, '../renderer/index.html')).toString(),
        isKnownSender: (sender) => isMainWindowSender(sender as Electron.WebContents)
      }),
    removeAttribute: removeIdeaAttribute,
    restoreIdea
  })
  const profileSaveController = createProfileSaveIpcController({
    authorization: {
      developmentUrl: process.env['ELECTRON_RENDERER_URL'],
      packagedRendererUrl: pathToFileURL(join(__dirname, '../renderer/index.html')).toString(),
      isKnownSender: (sender) => isMainWindowSender(sender as Electron.WebContents)
    }
  })
  const workspaceSessionController = createWorkspaceSessionIpcController({
    authorization: rendererAuthorization,
    list: (profileId) => workspaceSessions.list(profileId),
    setActive: (profileId, sessionId) => {
      const profile = getProfile(profileId)
      if (!profile) throw new Error('Workspace-Profil nicht gefunden.')
      return workspaceSessions.setActive(profileId, sessionId).engine.snapshot()
    },
    remove: async (profileId, sessionId) => {
      await agentManager.removeAll(profileId, sessionId)
      workspaceSessions.removeSession(sessionId)
      return workspaceSessions.list(profileId)
    }
  })
  const attentionController = createAttentionIpcController({
    authorization: rendererAuthorization
  })
  const requireMainWindow = (event: Electron.IpcMainInvokeEvent): void => {
    if (!isMainWindowSender(event.sender)) throw new Error('Remote-Verwaltung ist nur im Hauptfenster erlaubt.')
  }
  // The voice overlay window shares the renderer preload, so every privileged
  // agent/spawn/orchestrator channel must explicitly refuse it. Its only path to
  // mutate the workspace is the gated voiceAssistant:turn tool loop.
  const assertNotVoiceWindow = (
    event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent
  ): void => {
    guardNotVoiceWindow(isVoiceWindowSender(event.sender))
  }
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
  ipcMain.handle(IPC.appUpdateSetChannel, (event, channel: unknown) => {
    assertNotVoiceWindow(event)
    return setUpdateChannel(channel === 'stable' ? 'stable' : 'main')
  })
  ipcMain.handle(IPC.providersHealth, () => checkAllProviders())
  ipcMain.handle(IPC.providersCapacity, () => providerCapacity.statsAll())
  ipcMain.handle(IPC.diagnosticsExportLatest, async (e, profileId: string) => {
    await runJournal.flush()
    const latest = runJournal.list(String(profileId ?? ''))[0]
    if (!latest) return null
    const result = await saveRunDialog(
      senderWindow(e),
      `vertragus-run-${latest.runId}-${new Date(latest.updatedAt).toISOString().slice(0, 10)}.jsonl`
    )
    if (result.canceled || !result.filePath) return null
    runJournal.export(latest.runId, result.filePath)
    return result.filePath
  })
  ipcMain.handle(IPC.providerLogin, async (_e, id: unknown) => {
    const info = await agentManager.loginProvider(
      assertIpcId(id, 'Provider-Angabe', 64) as ProviderId
    )
    createPaneWindow(info.id)
    return info
  })
  ipcMain.handle(IPC.providersModels, () => listModels())
  ipcMain.handle(IPC.configGet, (_e, key: unknown) => getPublicConfig(assertValidConfigKey(key)))
  ipcMain.handle(IPC.configSet, (_e, key: unknown, value: unknown) => {
    const configKey = assertValidConfigKey(key)
    setPublicConfig(configKey, value)
    if (configKey === 'providerLimits') providerCapacity.refreshLimits()
    // Mirror the persisted value into every window so secondary windows
    // (agent panes, voice overlay) don't render stale shared UI settings.
    // Broadcasting the stored value (not the raw input) keeps receivers
    // canonical; receivers only mirror it, so there is no write-back loop.
    broadcast(IPC.evConfigChanged, { key: configKey, value: getPublicConfig(configKey) })
  })

  // ---- profiles ----
  ipcMain.handle(IPC.profilesList, () => listProfiles())
  ipcMain.handle(IPC.profileSave, async (e, input: unknown) => {
    const profile = profileSaveController.authorizeAndParse(e, input)
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
  ipcMain.handle(IPC.profileGenerateForRepo, (e, req: RepoProfileGenerationRequest) => {
    assertNotVoiceWindow(e)
    return generateProfileForRepo(req)
  })
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
  ipcMain.handle(IPC.workspaceSessionsList, (e, profileId?: unknown) =>
    workspaceSessionController.list(e, profileId)
  )
  ipcMain.handle(IPC.workspaceSessionSetActive, (e, profileId: unknown, sessionId: unknown) =>
    workspaceSessionController.setActive(e, profileId, sessionId)
  )
  ipcMain.handle(IPC.workspaceSessionRemove, (e, profileId: unknown, sessionId: unknown) =>
    workspaceSessionController.remove(e, profileId, sessionId)
  )

  // ---- restart recovery (startup banner) ----
  ipcMain.handle(IPC.sessionsRestoreStatus, (e) => {
    assertNotVoiceWindow(e)
    return sessionRestore.getRestoreStatus()
  })
  ipcMain.handle(IPC.sessionsRestartAgents, (e, profileId: unknown, sessionId: unknown) => {
    assertNotVoiceWindow(e)
    if (typeof profileId !== 'string' || typeof sessionId !== 'string') {
      throw new Error('Ungültige Session-Angabe.')
    }
    return sessionRestore.restartSessionAgents(profileId, sessionId)
  })
  ipcMain.handle(IPC.sessionsDiscardOrphanWorktree, (e, path: unknown) => {
    assertNotVoiceWindow(e)
    if (typeof path !== 'string') throw new Error('Ungültiger Worktree-Pfad.')
    return sessionRestore.discardOrphanWorktree(path)
  })
  ipcMain.handle(IPC.sessionsDiscardOrphanWorktrees, (e, paths: unknown) => {
    assertNotVoiceWindow(e)
    if (!Array.isArray(paths) || paths.some((path) => typeof path !== 'string')) {
      throw new Error('Ungültige Worktree-Pfade.')
    }
    return sessionRestore.discardOrphanWorktrees(paths)
  })

  // ---- external MCP servers ----
  ipcMain.handle(IPC.mcpList, () => listMcpServers())
  // mcpSave persists an arbitrary stdio command that is launched on the next agent
  // spawn — a code-execution primitive that must never be reachable from the voice overlay.
  ipcMain.handle(IPC.mcpSave, (e, servers: unknown) => {
    assertNotVoiceWindow(e)
    return saveMcpServers(parseIpcPayload(mcpServersSchema, servers, 'MCP-Server-Liste'))
  })

  // ---- git ----
  ipcMain.handle(IPC.gitSwitchBranch, (e, dir: unknown, branch: unknown) => {
    assertNotVoiceWindow(e)
    return switchBranch(
      assertIpcId(dir, 'Verzeichnisangabe', 4096),
      assertIpcId(branch, 'Branch-Angabe', 512)
    )
  })
  ipcMain.handle(IPC.gitInfo, (_e, dir: unknown) =>
    gitInfo(assertIpcId(dir, 'Verzeichnisangabe', 4096))
  )
  ipcMain.handle(IPC.githubProjects, (_e, dir: unknown, owner?: unknown) =>
    listGithubProjects(
      assertIpcId(dir, 'Verzeichnisangabe', 4096),
      assertIpcOptionalId(owner, 'Owner-Angabe', 200)
    )
  )
  ipcMain.handle(IPC.githubAuthStatus, () => githubAuthStatus())
  ipcMain.handle(IPC.githubAuthLogin, async (e) => {
    assertNotVoiceWindow(e)
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
  ipcMain.handle(IPC.githubAuthLogout, async (e) => {
    assertNotVoiceWindow(e)
    const status = await githubAuthLogout()
    void checkAllProviders()
      .then((health) => broadcast(IPC.evProvidersHealth, health))
      .catch((error) => console.warn('[GitHub] refresh after logout failed', error))
    return status
  })
  ipcMain.handle(IPC.githubRepoSearch, (e, query: unknown, limit?: unknown) => {
    assertNotVoiceWindow(e)
    const boundedLimit = typeof limit === 'number' && Number.isFinite(limit)
      ? Math.max(1, Math.min(50, Math.trunc(limit)))
      : undefined
    return searchGithubRepos(assertIpcId(query, 'Suchanfrage', 512), boundedLimit)
  })
  ipcMain.handle(IPC.githubRepoResolve, (_e, owner: unknown, repo: unknown) =>
    resolveGithubRepo(
      assertIpcId(owner, 'Owner-Angabe', 200),
      assertIpcId(repo, 'Repository-Angabe', 200)
    )
  )
  ipcMain.handle(IPC.githubRepoBind, (e, req: unknown) => {
    assertNotVoiceWindow(e)
    return bindGithubRepo(parseIpcPayload(githubRepoBindRequestSchema, req, 'Repository-Bindung'))
  })
  ipcMain.handle(IPC.githubRepoCheckLocal, (_e, owner: unknown, repo: unknown, localPath: unknown) =>
    checkGithubRepoLocal(
      assertIpcId(owner, 'Owner-Angabe', 200),
      assertIpcId(repo, 'Repository-Angabe', 200),
      assertIpcId(localPath, 'Pfadangabe', 4096)
    )
  )

  // ---- native folder picker ----
  ipcMain.handle(IPC.demoPlay, (e) => {
    const win = senderWindow(e)
    if (win) pushDemoState(win)
  })

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
  ipcMain.handle(IPC.ideasGet, (_e, id: unknown) => getIdea(assertIpcId(id, 'Ideen-ID')))
  ipcMain.handle(IPC.ideasCreate, (_e, input?: unknown) =>
    createIdea(
      input === undefined
        ? undefined
        : parseIpcPayload(createIdeaInputSchema, input, 'Ideen-Eingabe')
    )
  )
  ipcMain.handle(IPC.ideasUpdate, (_e, input: unknown) =>
    updateIdea(parseIpcPayload(updateIdeaInputSchema, input, 'Ideen-Aktualisierung'))
  )
  ipcMain.handle(IPC.ideasDelete, (_e, id: unknown) => deleteIdea(assertIpcId(id, 'Ideen-ID')))
  ipcMain.handle(IPC.ideasAddArtifact, async (_e, ideaId: unknown, input: unknown) =>
    addArtifact(
      assertIpcId(ideaId, 'Ideen-ID'),
      parseIpcPayload(addArtifactInputSchema, input, 'Artefakt-Eingabe')
    )
  )
  ipcMain.handle(IPC.ideasRemoveArtifact, (_e, ideaId: unknown, artifactId: unknown) =>
    removeArtifact(assertIpcId(ideaId, 'Ideen-ID'), assertIpcId(artifactId, 'Artefakt-ID'))
  )
  ipcMain.handle(IPC.ideasRemoveAttribute, (event, ideaId: unknown, attribute: unknown) =>
    inboxArchiveController.removeAttribute(event as ArchiveIpcEventLike, ideaId, attribute)
  )
  ipcMain.handle(IPC.ideasRestore, (event, ideaId: unknown) =>
    inboxArchiveController.restoreIdea(event as ArchiveIpcEventLike, ideaId)
  )
  ipcMain.handle(IPC.ideasTransferToProfile, (_e, req: unknown) =>
    transferIdeaToProfile(parseIpcPayload(ideaTransferRequestSchema, req, 'Transfer-Anfrage'))
  )
  ipcMain.handle(IPC.ideasTransferRetry, (_e, ideaId: unknown, yoloMaster?: unknown) =>
    retryIdeaTransfer(assertIpcId(ideaId, 'Ideen-ID'), yoloMaster === true)
  )
  ipcMain.handle(IPC.ideasEnhancePrompt, (event, request: unknown) =>
    promptController.enhance(event, request)
  )
  ipcMain.handle(IPC.ideasAbortPromptEnhancement, (event, request: unknown) =>
    promptController.abort(event, request)
  )
  ipcMain.handle(IPC.ideasTransferReset, (_e, ideaId: unknown) =>
    resetIdeaTransfer(assertIpcId(ideaId, 'Ideen-ID'))
  )

  // ---- inbox speech-to-text ----
  ipcMain.handle(IPC.inboxSpeechStatus, () => getInboxSpeechStatus())
  ipcMain.handle(IPC.inboxSpeechGetSettings, () => getInboxSpeechSettings())
  ipcMain.handle(IPC.inboxSpeechSetSettings, (_e, patch: unknown) =>
    setInboxSpeechSettings(
      parseIpcPayload(inboxSpeechSettingsPatchSchema, patch, 'Speech-Einstellungen')
    )
  )
  ipcMain.handle(IPC.inboxSpeechTranscribe, (_e, payload: TranscribeAudioPayload) =>
    // Payload shape (bounded base64 audio) is enforced inside transcribeInboxAudio.
    transcribeInboxAudio(payload)
  )
  ipcMain.handle(IPC.inboxSpeechAbort, () => {
    abortInboxTranscription()
  })

  // ---- Mission Control (desktop administration only) ----
  ipcMain.handle(IPC.remoteStatus, (event) => {
    requireMainWindow(event)
    return remoteService.status()
  })
  ipcMain.handle(IPC.remoteEnable, (event, request: RemoteEnableRequest) => {
    requireMainWindow(event)
    return remoteService.enable(request)
  })
  ipcMain.handle(IPC.remoteDisable, (event) => {
    requireMainWindow(event)
    return remoteService.disable()
  })
  ipcMain.handle(IPC.remoteListDevices, (event) => {
    requireMainWindow(event)
    return remoteService.listDevices()
  })
  ipcMain.handle(IPC.remoteRevokeDevice, (event, deviceId: string) => {
    requireMainWindow(event)
    return remoteService.revokeDevice(String(deviceId))
  })
  ipcMain.handle(IPC.remotePairStart, (event, request?: RemotePairStartRequest) => {
    requireMainWindow(event)
    return remoteService.startPairing(request)
  })
  ipcMain.handle(IPC.remoteSetApnsConfig, (event, config: unknown) => {
    requireMainWindow(event)
    return remoteService.setApnsConfig(config)
  })
  ipcMain.handle(IPC.remoteGetApnsConfigStatus, (event) => {
    requireMainWindow(event)
    return remoteService.getApnsConfigStatus()
  })
  ipcMain.handle(IPC.remoteClearApnsConfig, (event) => {
    requireMainWindow(event)
    return remoteService.clearApnsConfig()
  })

  // ---- agents ----
  ipcMain.handle(IPC.agentsList, () => agentManager.list())
  ipcMain.handle(IPC.agentSpawn, (e, rawRequest: unknown) => {
    assertNotVoiceWindow(e)
    const req: SpawnAgentRequest = parseIpcPayload(
      spawnAgentRequestSchema,
      rawRequest,
      'Agent-Startanfrage'
    )
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
  ipcMain.handle(IPC.agentsSpawnProfile, async (e, profileId: unknown, yoloMaster: unknown) => {
    assertNotVoiceWindow(e)
    const profile = getProfile(assertIpcId(profileId, 'Profil-ID'))
    if (!profile) return []
    return spawnProfileTeam(profile, yoloMaster === true, {
      workingDirOverride: getActiveRepoOverridePath()
    })
  })
  ipcMain.on(IPC.agentWrite, (e, id: string, data: string) => {
    if (isVoiceWindowSender(e.sender)) return
    agentManager.write(id, data)
  })
  ipcMain.on(IPC.agentMarkInteractiveUsed, (e, id: string) => {
    if (isVoiceWindowSender(e.sender)) return
    agentManager.markInteractiveUsed(id)
  })
  ipcMain.on(IPC.agentResize, (e, id: string, cols: number, rows: number) => {
    if (isVoiceWindowSender(e.sender)) return
    agentManager.resize(id, cols, rows)
  })
  ipcMain.handle(IPC.agentKill, (e, id: unknown) => {
    assertNotVoiceWindow(e)
    return agentManager.kill(assertIpcId(id, 'Agent-ID'))
  })
  ipcMain.handle(IPC.agentsKillAll, (e) => {
    assertNotVoiceWindow(e)
    return agentManager.killAll()
  })
  ipcMain.handle(IPC.agentsClean, async (e, rawProfileId: unknown, rawSessionId?: unknown) => {
    assertNotVoiceWindow(e)
    const profileId = assertIpcId(rawProfileId, 'Profil-ID')
    const workspaceSessionId = assertIpcOptionalId(rawSessionId, 'Workspace-Session-ID')
    await agentManager.removeAll(profileId, workspaceSessionId)
    if (workspaceSessionId) workspaceSessions.removeSession(workspaceSessionId)
    else workspaceSessions.remove(profileId)
  })
  ipcMain.handle(IPC.agentBuffer, (_e, id: unknown) =>
    agentManager.buffer(assertIpcId(id, 'Agent-ID'))
  )
  ipcMain.handle(IPC.agentBufferTail, (_e, id: unknown, maxChars: number) =>
    agentManager.bufferTail(assertIpcId(id, 'Agent-ID'), maxChars)
  )
  ipcMain.handle(IPC.agentPopout, (e, id: unknown) => {
    assertNotVoiceWindow(e)
    createPaneWindow(assertIpcId(id, 'Agent-ID'))
  })
  ipcMain.handle(IPC.agentHandoff, (e, req: unknown) => {
    assertNotVoiceWindow(e)
    return agentManager.handoff(parseIpcPayload(handoffRequestSchema, req, 'Übergabe-Anfrage'))
  })
  ipcMain.handle(IPC.agentsBulkHandoff, (e, req: unknown) => {
    assertNotVoiceWindow(e)
    return agentManager.bulkHandoff(
      parseIpcPayload(bulkHandoffRequestSchema, req, 'Massenübergabe-Anfrage')
    )
  })

  // ---- orchestrator ----
  ipcMain.handle(IPC.orchestratorSnapshot, (_e, profileId: string, workspaceSessionId?: string) => {
    const profile = getProfile(profileId)
    return profile
      ? workspaceSessions.snapshot(profile, workspaceSessionId)
      : { profileId, workspaceSessionId, goal: null, tasks: [] }
  })
  ipcMain.handle(IPC.orchestratorReset, (e, profileId: string, workspaceSessionId?: string) => {
    assertNotVoiceWindow(e)
    workspaceSessions.reset(requireProfile(profileId), workspaceSessionId)
  })
  ipcMain.handle(IPC.orchestratorEnableAutoMode, (e, profileId: string, workspaceSessionId?: string) => {
    assertNotVoiceWindow(e)
    return workspaceSessions.enableAutoMode(requireProfile(profileId), workspaceSessionId)
  })
  ipcMain.handle(
    IPC.orchestratorSetPlannerMode,
    (e, profileId: string, mode: WorkspaceProfile['planner']['mode'], workspaceSessionId?: string) => {
      assertNotVoiceWindow(e)
      if (mode !== 'auto' && mode !== 'review' && mode !== 'manual') {
        throw new Error(`Unbekannter Planungsmodus: ${String(mode)}`)
      }
      return workspaceSessions.setPlannerMode(requireProfile(profileId), mode, workspaceSessionId)
    }
  )
  ipcMain.handle(IPC.orchestratorSetYoloMaster, (e, enabled: boolean) => {
    assertNotVoiceWindow(e)
    return workspaceSessions.setYoloMaster(Boolean(enabled))
  })
  ipcMain.handle(IPC.orchestratorReviewPlan, (e, profileId: string, approved: boolean, workspaceSessionId?: string) => {
    assertNotVoiceWindow(e)
    return workspaceSessions.reviewPlan(requireProfile(profileId), Boolean(approved), workspaceSessionId)
  })
  ipcMain.handle(IPC.orchestratorTaskDiff, async (_e, profileId: unknown, taskId: unknown, workspaceSessionId?: unknown) => {
    const profile = getProfile(assertIpcId(profileId, 'Profil-ID'))
    if (!profile) throw new Error('Workspace-Profil nicht gefunden.')
    const requestedTaskId = assertIpcId(taskId, 'Task-ID')
    const task = workspaceSessions
      .snapshot(profile, assertIpcOptionalId(workspaceSessionId, 'Workspace-Session-ID'))
      .tasks.find((entry) => entry.id === requestedTaskId)
    if (!task) throw new Error('Aufgabe nicht gefunden.')
    return loadTaskReviewDiff(task)
  })
  ipcMain.handle(
    IPC.orchestratorApprovePublication,
    (e, profileId: string, workspaceSessionId: string, planId?: string) => {
      assertNotVoiceWindow(e)
      return workspaceSessions.approvePublication(requireProfile(profileId), planId, workspaceSessionId)
    }
  )
  ipcMain.handle(
    IPC.orchestratorRejectPublication,
    (e, profileId: string, workspaceSessionId: string, planId?: string) => {
      assertNotVoiceWindow(e)
      return workspaceSessions.rejectPublication(requireProfile(profileId), planId, workspaceSessionId)
    }
  )
  ipcMain.handle(
    IPC.orchestratorResolvePermission,
    (e, profileId: string, workspaceSessionId: string, permissionId: string, allow: boolean) => {
      assertNotVoiceWindow(e)
      const profile = requireProfile(profileId)
      if (!/^[0-9a-f-]{36}$/i.test(permissionId)) return false
      return workspaceSessions.resolvePermission(profile, permissionId, Boolean(allow), workspaceSessionId)
    }
  )
  ipcMain.handle(
    IPC.orchestratorSetBudgetCaps,
    (e, profileId: string, workspaceSessionId: string, caps: RemoteBudgetCaps) => {
      assertNotVoiceWindow(e)
      const profile = requireProfile(profileId)
      const maxTokens = caps?.maxTokens
      const maxCostUsd = caps?.maxCostUsd
      if (
        (maxTokens != null && (!Number.isInteger(maxTokens) || maxTokens < 1_000 || maxTokens > 1_000_000_000)) ||
        (maxCostUsd != null && (!Number.isFinite(maxCostUsd) || maxCostUsd < 0.01 || maxCostUsd > 1_000_000))
      ) throw new Error('Ungültige Budget-Grenzen.')
      return workspaceSessions.setBudgetCaps(profile, { maxTokens, maxCostUsd }, workspaceSessionId)
    }
  )
  ipcMain.handle(
    IPC.orchestratorPauseTask,
    (e, profileId: string, workspaceSessionId: string, taskId: string) => {
      assertNotVoiceWindow(e)
      return workspaceSessions.pauseTask(requireProfile(profileId), taskId, workspaceSessionId)
    }
  )
  ipcMain.handle(
    IPC.orchestratorResumeTask,
    (e, profileId: string, workspaceSessionId: string, taskId: string) => {
      assertNotVoiceWindow(e)
      return workspaceSessions.resumeTask(requireProfile(profileId), taskId, workspaceSessionId)
    }
  )
  ipcMain.handle(
    IPC.orchestratorResumeInterruptedTask,
    (e, profileId: string, workspaceSessionId: string, taskId: string) => {
      assertNotVoiceWindow(e)
      return workspaceSessions.resumeInterruptedTask(requireProfile(profileId), taskId, workspaceSessionId)
    }
  )
  ipcMain.handle(
    IPC.orchestratorFallbackTask,
    (e, profileId: string, workspaceSessionId: string, taskId: string) => {
      assertNotVoiceWindow(e)
      return workspaceSessions.fallbackTask(requireProfile(profileId), taskId, workspaceSessionId)
    }
  )
  // Canvas composer → seed a free-text message to the session's orchestrator agent.
  // Main-window only; the voice window has its own gated tool for this.
  ipcMain.handle(
    IPC.orchestratorSend,
    async (
      event,
      profileId: unknown,
      workspaceSessionId: unknown,
      text: unknown
    ): Promise<OrchestratorSendResult> => {
      requireMainWindow(event)
      return resolveOrchestratorSend(
        {
          hasProfile: (id) => Boolean(getProfile(id)),
          activeSessionId: (id) => workspaceSessions.list(id).find((session) => session.active)?.id,
          findOrchestratorId: (sessionId) =>
            agentManager
              .list()
              .find((agent) => agent.workspaceSessionId === sessionId && agent.kind === 'orchestrator')?.id,
          seed: (agentId, message) => agentManager.seedInteractive(agentId, message)
        },
        profileId,
        workspaceSessionId,
        text
      )
    }
  )

  // ---- voice assistant + overlay ----
  ipcMain.handle(
    IPC.voiceAssistantTurn,
    async (event, request: VoiceOverlayTurnRequest): Promise<VoiceOverlayTurnResult> => {
      // Only the overlay window (or the main window as a fallback host) may run a
      // turn. The turn itself runs the bounded tool loop entirely in the main
      // process; API keys never leave it.
      guardVoiceTurnAllowed(isVoiceWindowSender(event.sender), isMainWindowSender(event.sender))
      const turnRequest = adaptVoiceTurnRequest(request)
      const sender = event.sender
      const emitProgress = (progress: VoiceAssistantProgressEvent): void => {
        if (sender.isDestroyed()) return
        const enriched: VoiceAssistantProgressEvent =
          progress.stage === 'error'
            ? { ...progress, error: progress.error ?? progress.detail }
            : progress
        sender.send(IPC.evVoiceAssistant, enriched)
      }
      const result = await runVoiceAssistantTurn(turnRequest, emitProgress)
      for (const command of result.uiCommands) {
        broadcast(IPC.evUiCommand, command)
      }
      return adaptVoiceTurnResult(result)
    }
  )
  ipcMain.handle(IPC.voiceAssistantGetSettings, (event) => {
    requireMainWindow(event)
    return getVoiceAssistantSettings()
  })
  ipcMain.handle(IPC.voiceAssistantSetSettings, (event, patch: VoiceAssistantSettingsPatch) => {
    requireMainWindow(event)
    return setVoiceAssistantSettings(patch)
  })
  ipcMain.handle(IPC.voiceOverlayToggle, (event) => {
    requireMainWindow(event)
    toggleVoiceOverlay()
  })
  ipcMain.handle(IPC.voiceOverlayHide, (event) => {
    guardOverlayControl(isVoiceWindowSender(event.sender), isMainWindowSender(event.sender))
    hideVoiceOverlay()
  })
  ipcMain.on(IPC.voiceOverlayMoved, (event, x: number, y: number) => {
    if (!isVoiceWindowSender(event.sender)) return
    moveVoiceOverlay(Number(x), Number(y))
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

  // ---- attention (taskbar / dock flash) — one-way only ----
  ipcMain.on(IPC.attentionSetPendingFeedbackCount, (e, count: unknown) => {
    try {
      attentionController.setPendingFeedbackCount(e, count)
    } catch {
      // One-way channel: drop unauthorized / invalid payloads without a reply.
    }
  })

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
  // Targeted fanout: only the main window and this agent's pop-out pane(s)
  // render its terminal (Audit A6); every other window just discarded it.
  agentManager.on('data', (chunk) => broadcastAgentData(IPC.evAgentData, chunk.id, chunk))
  // changed() fires per usage snapshot / status flip / permission transition —
  // bursty during active runs. Coalesce to one trailing broadcast so the full
  // agent list isn't re-serialized to every window on every sub-second tick.
  let agentsChangedTimer: ReturnType<typeof setTimeout> | undefined
  let latestAgentList: AgentInstanceInfo[] = []
  agentManager.on('changed', (list: AgentInstanceInfo[]) => {
    latestAgentList = list
    if (agentsChangedTimer) return
    agentsChangedTimer = setTimeout(() => {
      agentsChangedTimer = undefined
      broadcast(IPC.evAgentsChanged, latestAgentList)
    }, 120)
    agentsChangedTimer.unref?.()
  })
  agentManager.on('event', (evt: VertragusEvent) => {
    recordDiagnostic(runJournal, {
      kind: 'agent-event',
      profileId: evt.profileId,
      workspaceSessionId: evt.workspaceSessionId,
      at: evt.time,
      payload: evt
    })
    broadcast(IPC.evVertragusEvent, evt)
  })
  workspaceSessions.on('changed', () => {
    broadcast(IPC.evWorkspaceSessions, workspaceSessions.list())
  })
  workspaceSessions.on('snapshot', (snap: OrchestratorSnapshot) => {
    if (snap.workspaceSessionId) {
      agentManager.setWorkspaceApprovalWaiting(snap.workspaceSessionId, Boolean(snap.pendingPlan))
    }
    const journalKey = snap.workspaceSessionId ?? snap.profileId ?? 'app'
    const signature = orchestratorSnapshotSignature(snap)
    if (lastJournaledSnapshotSig.get(journalKey) !== signature) {
      lastJournaledSnapshotSig.set(journalKey, signature)
      recordDiagnostic(runJournal, {
        kind: 'orchestrator-snapshot',
        profileId: snap.profileId,
        workspaceSessionId: snap.workspaceSessionId,
        payload: snap
      })
    }
    broadcast(IPC.evOrchestrator, snap)
  })
  remoteService.on('status', (status) => broadcast(IPC.evRemote, status))
  agentManager.on('provider-auth-complete', () => {
    void checkAllProviders()
      .then((health) => broadcast(IPC.evProvidersHealth, health))
      .catch((error) => console.warn('[Providers] refresh after login failed', error))
  })
  onUpdateState((next) => broadcast(IPC.evAppUpdateState, next))
}
