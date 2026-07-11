import type { ElectronAPI } from '@electron-toolkit/preload'
import type { OrcaApi } from '@shared/ipc'

declare global {
  interface Window {
    electron: ElectronAPI
    orca: OrcaApi
  }
}

export {}
