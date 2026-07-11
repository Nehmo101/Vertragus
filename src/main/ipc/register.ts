/**
 * Registers all ipcMain handlers. Each maps 1:1 onto a method in OrcaApi
 * (src/shared/ipc.ts) which the preload bridge exposes on window.orca.
 */
import { app, ipcMain, BrowserWindow } from 'electron'
import { IPC, type AppInfo } from '@shared/ipc'
import type { SpawnAgentRequest } from '@shared/agents'
import type { WorkspaceProfile } from '@shared/profile'
import { checkAllProviders } from '@main/providers/health'
import { listModels } from '@main/providers/models'
import { gitInfo } from '@main/integrations/git'
import { agentManager } from '@main/agents/AgentManager'
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
  ipcMain.handle(IPC.providersModels, () => listModels())
  ipcMain.handle(IPC.configGet, (_e, key: string) => getSetting(key))
  ipcMain.handle(IPC.configSet, (_e, key: string, value: unknown) => setSetting(key, value))

  // ---- profiles ----
  ipcMain.handle(IPC.profilesList, () => listProfiles())
  ipcMain.handle(IPC.profileSave, (_e, profile: WorkspaceProfile) => saveProfile(profile))
  ipcMain.handle(IPC.profileDelete, (_e, id: string) => deleteProfile(id))
  ipcMain.handle(IPC.profileGetActive, () => getActiveProfileId())
  ipcMain.handle(IPC.profileSetActive, (_e, id: string) => setActiveProfileId(id))

  // ---- git ----
  ipcMain.handle(IPC.gitInfo, (_e, dir: string) => gitInfo(dir))

  // ---- agents ----
  ipcMain.handle(IPC.agentsList, () => agentManager.list())
  ipcMain.handle(IPC.agentSpawn, (_e, req: SpawnAgentRequest) => agentManager.spawn(req))
  ipcMain.handle(IPC.agentsSpawnProfile, async (_e, profileId: string, yoloMaster: boolean) => {
    const profile = getProfile(profileId)
    if (!profile) return []
    const spawned: Awaited<ReturnType<typeof agentManager.spawn>>[] = []
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
  ipcMain.handle(IPC.agentBuffer, (_e, id: string) => agentManager.buffer(id))
  ipcMain.handle(IPC.agentPopout, (_e, id: string) => {
    createPaneWindow(id)
  })

  // ---- window controls (frameless title bar) ----
  ipcMain.on(IPC.winMinimize, (e) => senderWindow(e)?.minimize())
  ipcMain.on(IPC.winMaximizeToggle, (e) => {
    const win = senderWindow(e)
    if (!win) return
    win.isMaximized() ? win.unmaximize() : win.maximize()
  })
  ipcMain.on(IPC.winClose, (e) => senderWindow(e)?.close())

  // ---- push events: agent output / state / dispatch feed ----
  agentManager.on('data', (chunk) => broadcast(IPC.evAgentData, chunk))
  agentManager.on('changed', (list) => broadcast(IPC.evAgentsChanged, list))
  agentManager.on('event', (evt) => broadcast(IPC.evOrcaEvent, evt))
}
