/**
 * IPC for the Chromium-extension settings section.
 *
 * Same shape as remote/ipc.ts: settings-window-only, a push channel so the
 * connected/disconnected pill updates live, no writable settings key for the
 * pairing token (rotation lives here, not on `settings:set`).
 */
import type { BrowserExtensionStatus } from '@shared/browserExtension'
import type { BrowserBridge } from '@main/mcp/browserBridge'

export const BROWSER_EXTENSION_CHANNELS = {
  get: 'settings:browserExtension',
  regenerate: 'settings:browserExtensionRegenerate',
  reveal: 'settings:browserExtensionReveal',
  event: 'ev:browserExtension'
} as const

type IpcListener = (event: { sender: { id: number } }, ...args: never[]) => unknown

export interface BrowserExtensionIpcMain {
  handle(channel: string, listener: IpcListener): void
  removeHandler(channel: string): void
}

export interface BrowserExtensionIpcDeps {
  ipcMain: BrowserExtensionIpcMain
  bridge: () => BrowserBridge | undefined
  extensionPath: () => string
  reveal: (path: string) => Promise<string>
  isSettingsSender: (webContentsId: number) => boolean
  broadcast: (channel: string, payload: unknown) => void
}

export interface BrowserExtensionIpc {
  emit(): void
  dispose(): void
}

export function registerBrowserExtensionIpc(deps: BrowserExtensionIpcDeps): BrowserExtensionIpc {
  const guard =
    <T>(handler: (event: { sender: { id: number } }, arg: T) => unknown) =>
    (event: { sender: { id: number } }, arg: T): unknown => {
      if (!deps.isSettingsSender(event.sender.id)) {
        throw new Error('browser extension: settings channel is not available to this window')
      }
      return handler(event, arg)
    }

  const status = (): BrowserExtensionStatus => {
    const bridge = deps.bridge()
    const extensionPath = deps.extensionPath()
    if (!bridge) {
      return {
        port: 0,
        token: '',
        pairingUrl: '',
        connected: false,
        clients: 0,
        extensionPath
      }
    }
    const live = bridge.status()
    return { ...live, extensionPath }
  }

  const emit = (): void => deps.broadcast(BROWSER_EXTENSION_CHANNELS.event, status())

  deps.ipcMain.handle(BROWSER_EXTENSION_CHANNELS.get, guard((): BrowserExtensionStatus => status()) as IpcListener)
  deps.ipcMain.handle(
    BROWSER_EXTENSION_CHANNELS.regenerate,
    guard((): BrowserExtensionStatus => {
      deps.bridge()?.regenerateToken()
      const next = status()
      emit()
      return next
    }) as IpcListener
  )
  deps.ipcMain.handle(
    BROWSER_EXTENSION_CHANNELS.reveal,
    guard(async (): Promise<boolean> => {
      const path = deps.extensionPath()
      const error = await deps.reveal(path)
      if (error) throw new Error(error)
      return true
    }) as IpcListener
  )

  return {
    emit,
    dispose(): void {
      for (const channel of Object.values(BROWSER_EXTENSION_CHANNELS)) {
        if (channel !== BROWSER_EXTENSION_CHANNELS.event) deps.ipcMain.removeHandler(channel)
      }
    }
  }
}
