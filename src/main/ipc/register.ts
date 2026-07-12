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
import type { WorkspaceProfile } from '@shared/profile'
import { checkAllProviders } from '@main/providers/health'
import { listModels } from '@main/providers/models'
import { gitInfo } from '@main/integrations/git'
import { agentManager } from '@main/agents/AgentManager'
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
  setActiveProfileId
} from '@main/config/store'

function senderWindow(e: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(e.sender)
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
    if (!rawDir) return saveProfile(profile)
    const workingDir = resolve(rawDir)
    try {
      const info = await stat(workingDir)
      if (!info.isDirectory()) throw new Error('Pfad ist kein Verzeichnis.')
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`Workspace ist nicht zugreifbar: ${workingDir} (${detail})`)
    }
    return saveProfile({ ...profile, workingDir })
  })
  ipcMain.handle(IPC.profileDelete, (_e, id: string) => deleteProfile(id))
  ipcMain.handle(IPC.profileGetActive, () => getActiveProfileId())
  ipcMain.handle(IPC.profileSetActive, (_e, id: string) => {
    if (agentManager.anyRunning()) {
      throw new Error('Profilwechsel ist während einer laufenden Agent-Session gesperrt.')
    }
    setActiveProfileId(id)
  })

  // ---- git ----
  ipcMain.handle(IPC.gitInfo, (_e, dir: string) => gitInfo(dir))

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
}
