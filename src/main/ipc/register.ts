/**
 * Registers all ipcMain handlers. Each maps 1:1 onto a method in OrcaApi
 * (src/shared/ipc.ts) which the preload bridge exposes on window.orca.
 */
import { app, ipcMain } from 'electron'
import { IPC, type AppInfo } from '@shared/ipc'
import { checkAllProviders } from '@main/providers/health'
import {
  getSetting,
  setSetting,
  listProfiles,
  saveProfile
} from '@main/config/store'
import type { WorkspaceProfile } from '@shared/profile'

export function registerIpcHandlers(): void {
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

  ipcMain.handle(IPC.configGet, (_e, key: string) => getSetting(key))
  ipcMain.handle(IPC.configSet, (_e, key: string, value: unknown) => setSetting(key, value))

  ipcMain.handle(IPC.profilesList, () => listProfiles())
  ipcMain.handle(IPC.profileSave, (_e, profile: WorkspaceProfile) => saveProfile(profile))
}
