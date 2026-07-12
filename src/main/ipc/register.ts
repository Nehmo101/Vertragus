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
import { agentSlotsWithRoles, type WorkspaceProfile } from '@shared/profile'
import type { McpServerConfig } from '@shared/mcp'
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
import { agentManager } from '@main/agents/AgentManager'
import { workspaceSessions } from '@main/orchestrator/WorkspaceSessionRegistry'
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
  ipcMain.handle(IPC.configSet, (_e, key: string, value: unknown) => setSetting(key, value))

  // ---- profiles ----
  ipcMain.handle(IPC.profilesList, () => listProfiles())
  ipcMain.handle(IPC.profileSave, async (_e, profile: WorkspaceProfile) => {
    const rawDir = profile.workingDir.trim()
    const workingDir = rawDir ? await normalizeDirectory(rawDir, 'Workspace') : ''
    const agents = await Promise.all(
      profile.agents.map(async (slot, index) => ({
        ...slot,
        workingDir: slot.workingDir?.trim()
          ? await normalizeDirectory(slot.workingDir, `Pfad für Slot ${index + 1}`)
          : undefined
      }))
    )
    return saveProfile({ ...profile, workingDir, agents })
  })
  ipcMain.handle(IPC.profileDelete, (_e, id: string) => {
    if (agentManager.anyRunning(id)) {
      throw new Error('Profil löschen ist während einer laufenden Agent-Session gesperrt.')
    }
    workspaceSessions.remove(id)
    return deleteProfile(id)
  })
  ipcMain.handle(IPC.profileGetActive, () => getActiveProfileId())
  ipcMain.handle(IPC.profileSetActive, (_e, id: string) => {
    if (!getProfile(id)) {
      throw new Error('Workspace-Profil nicht gefunden.')
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

  // ---- agents ----
  ipcMain.handle(IPC.agentsList, () => agentManager.list())
  ipcMain.handle(IPC.agentSpawn, (_e, req: SpawnAgentRequest) => {
    if (!req.profileId) return agentManager.spawn(req)
    const profile = getProfile(req.profileId)
    if (!profile) throw new Error('Workspace-Profil nicht gefunden.')
    const session = workspaceSessions.ensure(profile)
    return agentManager.spawn({ ...req, workspaceSessionId: session.id })
  })
  ipcMain.handle(IPC.agentsSpawnProfile, async (_e, profileId: string, yoloMaster: boolean) => {
    const profile = getProfile(profileId)
    if (!profile) return []
    if (agentManager.anyRunning(profileId)) {
      throw new Error('Workspace laeuft bereits.')
    }
    await agentManager.removeAll(profileId)
    const session = workspaceSessions.start(profile)
    const engine = session.engine
    const spawned: Awaited<ReturnType<typeof agentManager.spawn>>[] = []

    // Team start: make every configured subagent available before opening the
    // orchestrator. This closes the startup race where an early dispatch could
    // allocate overflow capacity while the profile team was still spawning.
    for (const { slot, role } of agentSlotsWithRoles(profile.agents)) {
      for (let i = 1; i <= slot.count; i++) {
        spawned.push(
          await agentManager.spawn({
            provider: slot.provider,
            model: slot.model,
            role: `Subagent · ${role}${slot.count > 1 ? ` #${i}` : ''}`,
            teamRole: role,
            yolo: slot.yolo || yoloMaster,
            workingDir: slot.workingDir || profile.workingDir,
            profileId,
            workspaceSessionId: session.id
          })
        )
      }
    }
    if (profile.orchestrator) {
      spawned.unshift(
        await agentManager.spawn({
          provider: profile.orchestrator.provider,
          model: profile.orchestrator.model,
          kind: 'orchestrator',
          role: 'Orchestrator · plant & verteilt',
          yolo: yoloMaster,
          workingDir: profile.workingDir,
          profileId,
          workspaceSessionId: session.id
        })
      )
      engine.activate(profile)
    }
    return spawned
  })
  ipcMain.on(IPC.agentWrite, (_e, id: string, data: string) => agentManager.write(id, data))
  ipcMain.on(IPC.agentResize, (_e, id: string, cols: number, rows: number) =>
    agentManager.resize(id, cols, rows)
  )
  ipcMain.handle(IPC.agentKill, (_e, id: string) => agentManager.kill(id))
  ipcMain.handle(IPC.agentsKillAll, () => agentManager.killAll())
  ipcMain.handle(IPC.agentsClean, async (_e, profileId: string) => {
    await agentManager.removeAll(profileId)
    const profile = getProfile(profileId)
    if (profile) workspaceSessions.reset(profile)
  })
  ipcMain.handle(IPC.agentBuffer, (_e, id: string) => agentManager.buffer(id))
  ipcMain.handle(IPC.agentPopout, (_e, id: string) => {
    createPaneWindow(id)
  })
  ipcMain.handle(IPC.agentHandoff, (_e, req: HandoffRequest) => agentManager.handoff(req))

  // ---- orchestrator ----
  ipcMain.handle(IPC.orchestratorSnapshot, (_e, profileId: string) => {
    const profile = getProfile(profileId)
    return profile ? workspaceSessions.snapshot(profile) : { profileId, goal: null, tasks: [] }
  })
  ipcMain.handle(IPC.orchestratorReset, (_e, profileId: string) => {
    const profile = getProfile(profileId)
    if (profile) workspaceSessions.reset(profile)
  })
  ipcMain.handle(IPC.orchestratorReviewPlan, (_e, profileId: string, approved: boolean) => {
    const profile = getProfile(profileId)
    return profile ? workspaceSessions.reviewPlan(profile, Boolean(approved)) : false
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
  agentManager.on('data', (chunk) => broadcast(IPC.evAgentData, chunk))
  agentManager.on('changed', (list) => broadcast(IPC.evAgentsChanged, list))
  agentManager.on('event', (evt) => broadcast(IPC.evOrcaEvent, evt))
  workspaceSessions.on('snapshot', (snap) => broadcast(IPC.evOrchestrator, snap))
  agentManager.on('provider-auth-complete', () => {
    void checkAllProviders()
      .then((health) => broadcast(IPC.evProvidersHealth, health))
      .catch((error) => console.warn('[Providers] refresh after login failed', error))
  })
  onUpdateState((next) => broadcast(IPC.evAppUpdateState, next))
}
