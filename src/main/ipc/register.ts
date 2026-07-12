/**
 * Registers all ipcMain handlers. Each maps 1:1 onto a method in OrcaApi
 * (src/shared/ipc.ts) which the preload bridge exposes on window.orca.
 */
import { app, dialog, ipcMain, BrowserWindow } from 'electron'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { IPC, type AppInfo } from '@shared/ipc'
import type { HandoffRequest, SpawnAgentRequest } from '@shared/agents'
import type { ProviderId } from '@shared/providers'
import { profileRepoLocalPath, type WorkspaceProfile } from '@shared/profile'
import type { McpServerConfig } from '@shared/mcp'
import type { GithubRepoBindRequest } from '@shared/ipc'
import { checkAllProviders } from '@main/providers/health'
import { listModels } from '@main/providers/models'
import { gitInfo } from '@main/integrations/git'
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
import { orchestratorEngine } from '@main/orchestrator/Engine'
import { broadcast, createPaneWindow } from '@main/windows'
import {
  getSetting,
  setSetting,
  listProfiles,
  saveProfile,
  deleteProfile,
  getProfile,
  getActiveProfileId,
  setActiveProfileId,
  listMcpServers,
  saveMcpServers
} from '@main/config/store'
import {
  listIdeas,
  getIdea,
  createIdea,
  updateIdea,
  deleteIdea,
  addArtifact,
  removeArtifact
} from '@main/inbox/store'
import type { AddArtifactInput, CreateIdeaInput, UpdateIdeaInput } from '@shared/inbox'

function senderWindow(e: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(e.sender)
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
  ipcMain.handle(IPC.providerLogin, async (_e, id: ProviderId) => {
    const info = await agentManager.loginProvider(id)
    createPaneWindow(info.id)
    return info
  })
  ipcMain.handle(IPC.providersModels, () => listModels())
  ipcMain.handle(IPC.configGet, (_e, key: string) => getSetting(key))
  ipcMain.handle(IPC.configSet, (_e, key: string, value: unknown) => {
    setSetting(key, value)
    if (key === 'providerLimits') providerCapacity.refreshLimits()
  })

  // ---- profiles ----
  ipcMain.handle(IPC.profilesList, () => listProfiles())
  ipcMain.handle(IPC.profileSave, async (_e, profile: WorkspaceProfile) => {
    let workingDir = profile.workingDir.trim()
    let githubRepo = profile.githubRepo

    if (githubRepo) {
      const localPath = githubRepo.localPath?.trim()
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
  ipcMain.handle(IPC.profileDelete, (_e, id: string) => {
    if (id === getActiveProfileId() && agentManager.anyRunning()) {
      throw new Error('Profil löschen ist während einer laufenden Agent-Session gesperrt.')
    }
    return deleteProfile(id)
  })
  ipcMain.handle(IPC.profileGetActive, () => getActiveProfileId())
  ipcMain.handle(IPC.profileSetActive, (_e, id: string) => {
    if (agentManager.anyRunning()) {
      throw new Error('Profilwechsel ist während einer laufenden Agent-Session gesperrt.')
    }
    setActiveProfileId(id)
  })

  // ---- external MCP servers ----
  ipcMain.handle(IPC.mcpList, () => listMcpServers())
  ipcMain.handle(IPC.mcpSave, (_e, servers: McpServerConfig[]) => saveMcpServers(servers))

  // ---- git ----
  ipcMain.handle(IPC.gitInfo, (_e, dir: string) => gitInfo(dir))
  ipcMain.handle(IPC.githubProjects, (_e, dir: string, owner?: string) =>
    listGithubProjects(dir, owner)
  )
  ipcMain.handle(IPC.githubAuthStatus, () => githubAuthStatus())
  ipcMain.handle(IPC.githubAuthLogin, async () => {
    const status = await githubAuthLogin()
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
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
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

  // ---- agents ----
  ipcMain.handle(IPC.agentsList, () => agentManager.list())
  ipcMain.handle(IPC.agentSpawn, (_e, req: SpawnAgentRequest) => agentManager.spawn(req))
  ipcMain.handle(IPC.agentsSpawnProfile, async (_e, profileId: string, yoloMaster: boolean) => {
    const profile = getProfile(profileId)
    if (!profile) return []
    orchestratorEngine.reset()
    const spawned: Awaited<ReturnType<typeof agentManager.spawn>>[] = []

    // Team start: open the WHOLE team at once — the orchestrator (if any) plus
    // every subagent slot × its count — each as its own interactive pane. The
    // orchestrator additionally keeps its MCP tools to dispatch on-demand workers.
    if (profile.orchestrator) {
      spawned.push(
        await agentManager.spawn({
          provider: profile.orchestrator.provider,
          model: profile.orchestrator.model,
          modelPreset: profile.orchestrator.modelPreset,
          kind: 'orchestrator',
          role: 'Orchestrator · plant & verteilt',
          yolo: yoloMaster,
          workingDir: profile.workingDir
        })
      )
      orchestratorEngine.activate()
    }
    for (const slot of profile.agents) {
      for (let i = 1; i <= slot.count; i++) {
        spawned.push(
          await agentManager.spawn({
            provider: slot.provider,
            model: slot.model,
            modelPreset: slot.modelPreset,
            role: `Subagent · ${slot.role}${slot.count > 1 ? ` #${i}` : ''}`,
            yolo: slot.yolo || yoloMaster,
            workingDir: slot.workingDir || profile.workingDir
          })
        )
      }
    }
    return spawned
  })
  ipcMain.on(IPC.agentWrite, (_e, id: string, data: string) => agentManager.write(id, data))
  ipcMain.on(IPC.agentResize, (_e, id: string, cols: number, rows: number) =>
    agentManager.resize(id, cols, rows)
  )
  ipcMain.handle(IPC.agentKill, (_e, id: string) => agentManager.kill(id))
  ipcMain.handle(IPC.agentsKillAll, () => agentManager.killAll())
  ipcMain.handle(IPC.agentsClean, async () => {
    await agentManager.removeAll()
    orchestratorEngine.reset()
  })
  ipcMain.handle(IPC.agentBuffer, (_e, id: string) => agentManager.buffer(id))
  ipcMain.handle(IPC.agentPopout, (_e, id: string) => {
    createPaneWindow(id)
  })
  ipcMain.handle(IPC.agentHandoff, (_e, req: HandoffRequest) => agentManager.handoff(req))

  // ---- orchestrator ----
  ipcMain.handle(IPC.orchestratorSnapshot, () => orchestratorEngine.snapshot())
  ipcMain.handle(IPC.orchestratorReset, () => orchestratorEngine.reset())
  ipcMain.handle(IPC.orchestratorReviewPlan, (_e, approved: boolean) =>
    orchestratorEngine.reviewPlan(Boolean(approved)))

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
  agentManager.on('event', (evt) => broadcast(IPC.evOrcaEvent, evt))
  orchestratorEngine.on('snapshot', (snap) => broadcast(IPC.evOrchestrator, snap))
  agentManager.on('provider-auth-complete', () => {
    void checkAllProviders()
      .then((health) => broadcast(IPC.evProvidersHealth, health))
      .catch((error) => console.warn('[Providers] refresh after login failed', error))
  })
  onUpdateState((next) => broadcast(IPC.evAppUpdateState, next))
}
