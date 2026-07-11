import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { IPC, type OrcaApi } from '@shared/ipc'

const orca: OrcaApi = {
  getAppInfo: () => ipcRenderer.invoke(IPC.appInfo),
  checkProviders: () => ipcRenderer.invoke(IPC.providersHealth),
  getConfig: (key) => ipcRenderer.invoke(IPC.configGet, key),
  setConfig: (key, value) => ipcRenderer.invoke(IPC.configSet, key, value),
  listProfiles: () => ipcRenderer.invoke(IPC.profilesList),
  saveProfile: (profile) => ipcRenderer.invoke(IPC.profileSave, profile)
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('orca', orca)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (fallback when context isolation is disabled)
  window.electron = electronAPI
  // @ts-ignore
  window.orca = orca
}
