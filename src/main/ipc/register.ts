/**
 * Main-process side of the IPC surface. The declarative channel manifest
 * (src/shared/ipcManifest.ts) is the single source of truth for channel names,
 * directions, authorization levels and central zod validation; this module
 * provides the typed handler implementations (ManifestHandlers) and wires them
 * via registerManifestChannels — plus the main→renderer push feeds at the
 * bottom. See docs/IPC_ARCHITECTURE.md.
 */
import { app, dialog, BrowserWindow } from 'electron'
import { stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { IPC } from '@shared/ipc'
import { assertIpcId, assertIpcOptionalId, assertValidConfigKey } from '@shared/ipcValidation'
import type { AgentInstanceInfo, VertragusEvent } from '@shared/agents'
import type { OrchestratorSnapshot } from '@shared/orchestrator'
import type { ProviderId } from '@shared/providers'
import { profileRepoLocalPath, type WorkspaceProfile } from '@shared/profile'
import { registerManifestChannels, type ManifestHandlers } from './registerManifest'
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
import { listOpenIssues } from '@main/integrations/githubIssues'
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
  isRailWindowSender,
  isVoiceWindowSender,
  moveRailWindow,
  moveVoiceOverlay,
  openMainWindow,
  pushDemoState,
  tileAgentWindows,
  toggleRailWindow,
  toggleVoiceOverlay
} from '@main/windows'
import { guardRailControl } from '@main/ipc/railGuards'
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
import type { VoiceAssistantProgressEvent } from '@shared/voiceAssistant'
import { RunJournal } from '@main/diagnostics/runJournal'
import { loadTaskReviewDiff } from '@main/integrations/reviewDiff'
import { openWorktreeInEditor } from '@main/integrations/openInEditor'
import { createMainPromptEnhancementService } from '@main/inbox/promptEnhancementProvider'
import { inspectPromptWorkspaceContext } from '@main/inbox/promptEnhancementContext'
import {
  assertAuthorizedPromptEnhancementSender,
  createPromptEnhancementIpcController,
  type PromptIpcWebContentsLike
} from '@main/inbox/promptEnhancementIpc'
import { remoteService } from '@main/remote'
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
  const requireMainWindow = (
    event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent
  ): void => {
    if (!isMainWindowSender(event.sender)) throw new Error('Remote-Verwaltung ist nur im Hauptfenster erlaubt.')
  }
  // The voice overlay window shares the renderer preload, so every privileged
  // agent/spawn/orchestrator channel must explicitly refuse it (manifest auth
  // level 'not-voice', enforced centrally by registerManifestChannels). Its only
  // path to mutate the workspace is the gated voiceAssistant:turn tool loop.
  const assertNotVoiceWindow = (
    event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent
  ): void => {
    guardNotVoiceWindow(isVoiceWindowSender(event.sender))
  }

  // -------------------------------------------------------------------------
  // Handler implementations, one per manifest invoke/send channel. The mapped
  // ManifestHandlers type pins argument + result types to VertragusApi.
  // Authorization ('not-voice' / 'main-window' / 'voice-window') and zod
  // parsing (validation 'schema') run centrally BEFORE these bodies; channels
  // with auth 'controller' / 'custom' authorize inside their body.
  // -------------------------------------------------------------------------
  const manifestHandlers: ManifestHandlers = {
    // ---- app / updates / diagnostics ----
    appInfo: () => ({
      name: app.getName(),
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform
    }),
    appUpdateState: () => getUpdateState(),
    appUpdateCheck: () => checkForMainUpdate(),
    appUpdateDownload: () => downloadMainUpdate(),
    appUpdateInstall: () => installMainUpdate(),
    appUpdateSetChannel: (_e, channel) =>
      setUpdateChannel(channel === 'stable' ? 'stable' : 'main'),
    diagnosticsExportLatest: async (e, profileId) => {
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
    },

    // ---- providers / config ----
    providersHealth: () => checkAllProviders(),
    providersCapacity: () => providerCapacity.statsAll(),
    providersModels: () => listModels(),
    providerLogin: async (_e, id) => {
      const info = await agentManager.loginProvider(
        assertIpcId(id, 'Provider-Angabe', 64) as ProviderId
      )
      createPaneWindow(info.id)
      return info
    },
    configGet: (_e, key) => getPublicConfig(assertValidConfigKey(key)),
    configSet: (_e, key, value) => {
      const configKey = assertValidConfigKey(key)
      setPublicConfig(configKey, value)
      if (configKey === 'providerLimits') providerCapacity.refreshLimits()
      // Mirror the persisted value into every window so secondary windows
      // (agent panes, voice overlay) don't render stale shared UI settings.
      // Broadcasting the stored value (not the raw input) keeps receivers
      // canonical; receivers only mirror it, so there is no write-back loop.
      broadcast(IPC.evConfigChanged, { key: configKey, value: getPublicConfig(configKey) })
    },

    // ---- profiles ----
    profilesList: () => listProfiles(),
    profileSave: async (e, input) => {
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
      const profiles = saveProfile({ ...profile, workingDir: effectiveWorkingDir, githubRepo, agents })
      // Sekundärfenster (Rail, Panes) spiegeln die Profilliste live.
      broadcast(IPC.evProfilesChanged, profiles)
      return profiles
    },
    profileGenerateForRepo: (_e, req) => generateProfileForRepo(req),
    profileDelete: async (e, id) => {
      const profiles = await profileDeletionController.delete(e, id)
      broadcast(IPC.evProfilesChanged, profiles)
      return profiles
    },
    profileGetActive: () => getActiveProfileId(),
    profileSetActive: (_e, id) => {
      if (!getProfile(id)) {
        throw new Error('Workspace-Profil nicht gefunden.')
      }
      setActiveProfileId(id)
    },
    workspaceSessionsList: (e, profileId) => workspaceSessionController.list(e, profileId),
    workspaceSessionSetActive: (e, profileId, sessionId) =>
      workspaceSessionController.setActive(e, profileId, sessionId),
    workspaceSessionRemove: (e, profileId, sessionId) =>
      workspaceSessionController.remove(e, profileId, sessionId),

    // ---- restart recovery (startup banner) ----
    sessionsRestoreStatus: () => sessionRestore.getRestoreStatus(),
    sessionsRestartAgents: (_e, profileId, sessionId) => {
      if (typeof profileId !== 'string' || typeof sessionId !== 'string') {
        throw new Error('Ungültige Session-Angabe.')
      }
      return sessionRestore.restartSessionAgents(profileId, sessionId)
    },
    sessionsDiscardOrphanWorktree: (_e, path) => {
      if (typeof path !== 'string') throw new Error('Ungültiger Worktree-Pfad.')
      return sessionRestore.discardOrphanWorktree(path)
    },
    sessionsDiscardOrphanWorktrees: (_e, paths) => {
      if (!Array.isArray(paths) || paths.some((path) => typeof path !== 'string')) {
        throw new Error('Ungültige Worktree-Pfade.')
      }
      return sessionRestore.discardOrphanWorktrees(paths)
    },

    // ---- external MCP servers ----
    mcpList: () => listMcpServers(),
    // servers arrive zod-parsed (manifest validation 'schema': mcpServersSchema).
    mcpSave: (_e, servers) => saveMcpServers(servers),

    // ---- git / github ----
    gitSwitchBranch: (_e, dir, branch) =>
      switchBranch(
        assertIpcId(dir, 'Verzeichnisangabe', 4096),
        assertIpcId(branch, 'Branch-Angabe', 512)
      ),
    gitInfo: (_e, dir) => gitInfo(assertIpcId(dir, 'Verzeichnisangabe', 4096)),
    githubProjects: (_e, dir, owner) =>
      listGithubProjects(
        assertIpcId(dir, 'Verzeichnisangabe', 4096),
        assertIpcOptionalId(owner, 'Owner-Angabe', 200)
      ),
    githubAuthStatus: () => githubAuthStatus(),
    githubAuthLogin: async () => {
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
    },
    githubAuthLogout: async () => {
      const status = await githubAuthLogout()
      void checkAllProviders()
        .then((health) => broadcast(IPC.evProvidersHealth, health))
        .catch((error) => console.warn('[GitHub] refresh after logout failed', error))
      return status
    },
    githubRepoSearch: (_e, query, limit) => {
      const boundedLimit = typeof limit === 'number' && Number.isFinite(limit)
        ? Math.max(1, Math.min(50, Math.trunc(limit)))
        : undefined
      return searchGithubRepos(assertIpcId(query, 'Suchanfrage', 512), boundedLimit)
    },
    githubRepoResolve: (_e, owner, repo) =>
      resolveGithubRepo(
        assertIpcId(owner, 'Owner-Angabe', 200),
        assertIpcId(repo, 'Repository-Angabe', 200)
      ),
    githubRepoBind: (_e, req) => bindGithubRepo(req),
    githubRepoCheckLocal: (_e, owner, repo, localPath) =>
      checkGithubRepoLocal(
        assertIpcId(owner, 'Owner-Angabe', 200),
        assertIpcId(repo, 'Repository-Angabe', 200),
        assertIpcId(localPath, 'Pfadangabe', 4096)
      ),
    githubListIssues: (_e, req) => listOpenIssues(req),

    // ---- native pickers / demo ----
    demoPlay: (e) => {
      const win = senderWindow(e)
      if (win) pushDemoState(win)
    },
    dialogPickFolder: async (e) => {
      const win = senderWindow(e)
      const opts: Electron.OpenDialogOptions = {
        title: 'Arbeitsverzeichnis / Repo wählen',
        properties: ['openDirectory', 'createDirectory']
      }
      const result = win
        ? await dialog.showOpenDialog(win, opts)
        : await dialog.showOpenDialog(opts)
      return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
    },
    dialogPickFile: async (e) => {
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
    },

    // ---- ideas inbox ----
    ideasList: () => listIdeas(),
    ideasGet: (_e, id) => getIdea(assertIpcId(id, 'Ideen-ID')),
    ideasCreate: (_e, input) => createIdea(input),
    ideasUpdate: (_e, input) => updateIdea(input),
    ideasDelete: (_e, id) => deleteIdea(assertIpcId(id, 'Ideen-ID')),
    ideasAddArtifact: (_e, ideaId, input) => addArtifact(assertIpcId(ideaId, 'Ideen-ID'), input),
    ideasRemoveArtifact: (_e, ideaId, artifactId) =>
      removeArtifact(assertIpcId(ideaId, 'Ideen-ID'), assertIpcId(artifactId, 'Artefakt-ID')),
    ideasRemoveAttribute: (event, ideaId, attribute) =>
      inboxArchiveController.removeAttribute(event as ArchiveIpcEventLike, ideaId, attribute),
    ideasRestore: (event, ideaId) =>
      inboxArchiveController.restoreIdea(event as ArchiveIpcEventLike, ideaId),
    ideasTransferToProfile: (_e, req) => transferIdeaToProfile(req),
    ideasTransferRetry: (_e, ideaId, yoloMaster) =>
      retryIdeaTransfer(assertIpcId(ideaId, 'Ideen-ID'), yoloMaster === true),
    ideasEnhancePrompt: (event, request) => promptController.enhance(event, request),
    ideasAbortPromptEnhancement: (event, request) => promptController.abort(event, request),
    ideasTransferReset: (_e, ideaId) => resetIdeaTransfer(assertIpcId(ideaId, 'Ideen-ID')),

    // ---- inbox speech-to-text ----
    inboxSpeechStatus: () => getInboxSpeechStatus(),
    inboxSpeechGetSettings: () => getInboxSpeechSettings(),
    inboxSpeechSetSettings: (_e, patch) => setInboxSpeechSettings(patch),
    // Payload shape (bounded base64 audio) is enforced inside transcribeInboxAudio.
    inboxSpeechTranscribe: (_e, payload) => transcribeInboxAudio(payload),
    inboxSpeechAbort: () => {
      abortInboxTranscription()
    },

    // ---- Mission Control (desktop administration only; auth 'main-window') ----
    remoteStatus: () => remoteService.status(),
    remoteEnable: (_e, request) => remoteService.enable(request),
    remoteDisable: () => remoteService.disable(),
    remoteListDevices: () => remoteService.listDevices(),
    remoteRevokeDevice: (_e, deviceId) => remoteService.revokeDevice(String(deviceId)),
    remotePairStart: (_e, request) => remoteService.startPairing(request),
    remoteSetApnsConfig: (_e, config) => remoteService.setApnsConfig(config),
    remoteGetApnsConfigStatus: () => remoteService.getApnsConfigStatus(),
    remoteClearApnsConfig: () => remoteService.clearApnsConfig(),

    // ---- agents ----
    agentsList: () => agentManager.list(),
    // req arrives zod-parsed (spawnAgentRequestSchema).
    agentSpawn: (_e, req) => {
      if (!req.profileId) return agentManager.spawn(req)
      const profile = getProfile(req.profileId)
      if (!profile) throw new Error('Workspace-Profil nicht gefunden.')
      const session = workspaceSessions.ensure(profile)
      return agentManager.spawn({
        ...req,
        workspaceSessionId: session.id,
        engineId: session.engine.engineId
      })
    },
    agentsSpawnProfile: async (_e, profileId, yoloMaster) => {
      const profile = getProfile(assertIpcId(profileId, 'Profil-ID'))
      if (!profile) return []
      return spawnProfileTeam(profile, yoloMaster === true, {
        workingDirOverride: getActiveRepoOverridePath()
      })
    },
    agentWrite: (_e, id, data) => {
      agentManager.write(id, data)
    },
    agentMarkInteractiveUsed: (_e, id) => {
      agentManager.markInteractiveUsed(id)
    },
    agentResize: (_e, id, cols, rows) => {
      agentManager.resize(id, cols, rows)
    },
    agentKill: (_e, id) => agentManager.kill(assertIpcId(id, 'Agent-ID')),
    agentsKillAll: () => agentManager.killAll(),
    agentsClean: async (_e, rawProfileId, rawSessionId) => {
      const profileId = assertIpcId(rawProfileId, 'Profil-ID')
      const workspaceSessionId = assertIpcOptionalId(rawSessionId, 'Workspace-Session-ID')
      await agentManager.removeAll(profileId, workspaceSessionId)
      if (workspaceSessionId) workspaceSessions.removeSession(workspaceSessionId)
      else workspaceSessions.remove(profileId)
    },
    agentBuffer: (_e, id) => agentManager.buffer(assertIpcId(id, 'Agent-ID')),
    agentBufferTail: (_e, id, maxChars) =>
      agentManager.bufferTail(assertIpcId(id, 'Agent-ID'), maxChars),
    agentPopout: (_e, id) => {
      createPaneWindow(assertIpcId(id, 'Agent-ID'))
    },
    agentHandoff: (_e, req) => agentManager.handoff(req),
    agentsBulkHandoff: (_e, req) => agentManager.bulkHandoff(req),

    // ---- orchestrator ----
    orchestratorSnapshot: (_e, profileId, workspaceSessionId) => {
      const profile = getProfile(profileId)
      return profile
        ? workspaceSessions.snapshot(profile, workspaceSessionId)
        : { profileId, workspaceSessionId, goal: null, tasks: [] }
    },
    orchestratorReset: (_e, profileId, workspaceSessionId) => {
      workspaceSessions.reset(requireProfile(profileId), workspaceSessionId)
    },
    orchestratorEnableAutoMode: (_e, profileId, workspaceSessionId) =>
      workspaceSessions.enableAutoMode(requireProfile(profileId), workspaceSessionId),
    orchestratorSetPlannerMode: (_e, profileId, mode, workspaceSessionId) => {
      if (mode !== 'auto' && mode !== 'review' && mode !== 'manual') {
        throw new Error(`Unbekannter Planungsmodus: ${String(mode)}`)
      }
      return workspaceSessions.setPlannerMode(requireProfile(profileId), mode, workspaceSessionId)
    },
    orchestratorSetYoloMaster: (_e, enabled) => workspaceSessions.setYoloMaster(Boolean(enabled)),
    orchestratorReviewPlan: (_e, profileId, approved, workspaceSessionId) =>
      workspaceSessions.reviewPlan(requireProfile(profileId), Boolean(approved), workspaceSessionId),
    orchestratorTaskDiff: async (_e, profileId, taskId, workspaceSessionId) => {
      const profile = getProfile(assertIpcId(profileId, 'Profil-ID'))
      if (!profile) throw new Error('Workspace-Profil nicht gefunden.')
      const requestedTaskId = assertIpcId(taskId, 'Task-ID')
      const task = workspaceSessions
        .snapshot(profile, assertIpcOptionalId(workspaceSessionId, 'Workspace-Session-ID'))
        .tasks.find((entry) => entry.id === requestedTaskId)
      if (!task) throw new Error('Aufgabe nicht gefunden.')
      return loadTaskReviewDiff(task)
    },
    orchestratorOpenTaskWorktree: async (_e, profileId, taskId, workspaceSessionId) => {
      const profile = requireProfile(profileId)
      const requestedTaskId = assertIpcId(taskId, 'Task-ID')
      const task = workspaceSessions
        .snapshot(profile, assertIpcOptionalId(workspaceSessionId, 'Workspace-Session-ID'))
        .tasks.find((entry) => entry.id === requestedTaskId)
      // Only paths the engine itself recorded for this task are ever opened —
      // the renderer supplies IDs, never filesystem paths.
      const worktree = task?.worktree ?? task?.recoveryArtifact?.worktree
      if (!worktree) throw new Error('Für diese Aufgabe liegt kein Worktree vor.')
      await stat(worktree).catch(() => {
        throw new Error('Der Worktree existiert nicht mehr (vermutlich bereits aufgeräumt).')
      })
      return openWorktreeInEditor(worktree)
    },
    orchestratorApprovePublication: (_e, profileId, workspaceSessionId, planId) =>
      workspaceSessions.approvePublication(requireProfile(profileId), planId, workspaceSessionId),
    orchestratorRejectPublication: (_e, profileId, workspaceSessionId, planId) =>
      workspaceSessions.rejectPublication(requireProfile(profileId), planId, workspaceSessionId),
    orchestratorResolvePermission: (_e, profileId, workspaceSessionId, permissionId, allow) => {
      const profile = requireProfile(profileId)
      if (!/^[0-9a-f-]{36}$/i.test(permissionId)) return false
      return workspaceSessions.resolvePermission(profile, permissionId, Boolean(allow), workspaceSessionId)
    },
    orchestratorSetBudgetCaps: (_e, profileId, workspaceSessionId, caps) => {
      const profile = requireProfile(profileId)
      const maxTokens = caps?.maxTokens
      const maxCostUsd = caps?.maxCostUsd
      if (
        (maxTokens != null && (!Number.isInteger(maxTokens) || maxTokens < 1_000 || maxTokens > 1_000_000_000)) ||
        (maxCostUsd != null && (!Number.isFinite(maxCostUsd) || maxCostUsd < 0.01 || maxCostUsd > 1_000_000))
      ) throw new Error('Ungültige Budget-Grenzen.')
      return workspaceSessions.setBudgetCaps(profile, { maxTokens, maxCostUsd }, workspaceSessionId)
    },
    orchestratorPauseTask: (_e, profileId, workspaceSessionId, taskId) =>
      workspaceSessions.pauseTask(requireProfile(profileId), taskId, workspaceSessionId),
    orchestratorResumeTask: (_e, profileId, workspaceSessionId, taskId) =>
      workspaceSessions.resumeTask(requireProfile(profileId), taskId, workspaceSessionId),
    orchestratorResumeInterruptedTask: (_e, profileId, workspaceSessionId, taskId) =>
      workspaceSessions.resumeInterruptedTask(requireProfile(profileId), taskId, workspaceSessionId),
    orchestratorFallbackTask: (_e, profileId, workspaceSessionId, taskId) =>
      workspaceSessions.fallbackTask(requireProfile(profileId), taskId, workspaceSessionId),
    // Canvas composer → seed a free-text message to the session's orchestrator
    // agent. Auth 'main-window' (central); the voice window has its own gated tool.
    orchestratorSend: async (_event, profileId, workspaceSessionId, text) =>
      resolveOrchestratorSend(
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
      ),

    // ---- voice assistant + overlay ----
    voiceAssistantTurn: async (event, request) => {
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
    },
    voiceAssistantGetSettings: () => getVoiceAssistantSettings(),
    voiceAssistantSetSettings: (_e, patch) => setVoiceAssistantSettings(patch),
    voiceOverlayToggle: () => {
      toggleVoiceOverlay()
    },
    voiceOverlayHide: (event) => {
      guardOverlayControl(isVoiceWindowSender(event.sender), isMainWindowSender(event.sender))
      hideVoiceOverlay()
    },
    // Auth 'voice-window': non-overlay senders are dropped centrally.
    voiceOverlayMoved: (_e, x, y) => {
      moveVoiceOverlay(Number(x), Number(y))
    },

    // ---- desktop rail ----
    railToggle: () => {
      toggleRailWindow()
    },
    railOpenMain: (event) => {
      guardRailControl(isRailWindowSender(event.sender), isMainWindowSender(event.sender))
      openMainWindow()
    },
    // Auth 'custom' (send): non-rail senders are dropped without a reply.
    railMoved: (event, x, y) => {
      if (!isRailWindowSender(event.sender)) return
      moveRailWindow(Number(x), Number(y))
    },
    railLaunchTiled: async (event, profileId, yoloMaster) => {
      guardRailControl(isRailWindowSender(event.sender), isMainWindowSender(event.sender))
      const profile = getProfile(assertIpcId(profileId, 'Profil-ID'))
      if (!profile) throw new Error('Workspace-Profil nicht gefunden.')
      // Läuft die Session schon? Dann nur fokussieren + neu kacheln.
      const running = agentManager
        .list()
        .filter((agent) => agent.profileId === profile.id && agent.status === 'running')
      const agents = running.length > 0
        ? running
        : await spawnProfileTeam(profile, yoloMaster === true, {
            workingDirOverride: getActiveRepoOverridePath()
          })
      const primaryIndex = Math.max(0, agents.findIndex((agent) => agent.kind === 'orchestrator'))
      tileAgentWindows(agents.map((agent) => agent.id), primaryIndex)
    },

    // ---- retro / model learnings / benchmarks ----
    retroListRetros: (_e, profileId) => listRunRetros(profileId ? String(profileId) : undefined),
    retroListLearnings: () => listModelLearnings(),
    retroListBenchmarks: (_e, profileId) =>
      listBenchmarkRecords(profileId ? String(profileId) : undefined),
    retroSyncStatus: () => retroSyncStatus(),
    retroSyncFlush: () => flushRetroExportQueue(),

    // ---- window controls (frameless title bar) ----
    winMinimize: (e) => senderWindow(e)?.minimize(),
    winMaximizeToggle: (e) => {
      const win = senderWindow(e)
      if (!win) return
      if (win.isMaximized()) win.unmaximize()
      else win.maximize()
    },
    winClose: (e) => senderWindow(e)?.close(),

    // ---- attention (taskbar / dock flash) — one-way only ----
    attentionSetPendingFeedbackCount: (e, count) => {
      try {
        attentionController.setPendingFeedbackCount(e, count)
      } catch {
        // One-way channel: drop unauthorized / invalid payloads without a reply.
      }
    }
  }

  registerManifestChannels(manifestHandlers, {
    assertNotVoiceWindow,
    requireMainWindow,
    isVoiceWindowSender
  })

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
