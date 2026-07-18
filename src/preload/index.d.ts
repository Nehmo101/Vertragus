import type { ElectronAPI } from '@electron-toolkit/preload'
import type { VertragusApi } from '@shared/ipc'

declare global {
  interface Window {
    electron: ElectronAPI
    vertragus: VertragusApi
  }
}

export {}
