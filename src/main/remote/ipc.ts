/**
 * IPC for the remote-access settings section.
 *
 * Kept in `remote/` rather than folded into the big app IPC: the remote
 * concerns (controller lifecycle, bind-interface enumeration) live together,
 * and the channels are guarded exactly like the other settings writes — only
 * the settings window may read or change them. A push channel (`ev:remote`)
 * keeps the section live as clients connect and disconnect.
 */
import type { BindOption } from './interfaces'
import type { RemoteController, RemoteStatus } from './controller'

export const REMOTE_CHANNELS = {
  get: 'remote:get',
  set: 'remote:set',
  regenerateToken: 'remote:regenerateToken',
  clients: 'remote:clients',
  revokeClient: 'remote:revokeClient',
  interfaces: 'remote:interfaces',
  event: 'ev:remote'
} as const

type IpcListener = (event: { sender: { id: number } }, ...args: never[]) => unknown

export interface RemoteIpcMain {
  handle(channel: string, listener: IpcListener): void
  removeHandler(channel: string): void
}

export interface RemoteIpcDeps {
  ipcMain: RemoteIpcMain
  controller: RemoteController
  bindOptions: () => BindOption[]
  /** Only the settings window may touch remote config. */
  isSettingsSender: (webContentsId: number) => boolean
  /** Push a fresh status to every settings window. */
  broadcast: (channel: string, payload: unknown) => void
}

export interface RemoteIpc {
  /** Push the current status (server started/stopped, a client connected…). */
  emit(): void
  dispose(): void
}

export function registerRemoteIpc(deps: RemoteIpcDeps): RemoteIpc {
  const guard =
    <T>(handler: (event: { sender: { id: number } }, arg: T) => unknown) =>
    (event: { sender: { id: number } }, arg: T): unknown => {
      if (!deps.isSettingsSender(event.sender.id)) {
        throw new Error('remote: settings channel is not available to this window')
      }
      return handler(event, arg)
    }

  const emit = (): void => deps.broadcast(REMOTE_CHANNELS.event, deps.controller.status())

  deps.ipcMain.handle(
    REMOTE_CHANNELS.get,
    guard((): RemoteStatus => deps.controller.status()) as IpcListener
  )
  deps.ipcMain.handle(
    REMOTE_CHANNELS.set,
    guard(async (_event, patch: unknown): Promise<RemoteStatus> => {
      const status = await deps.controller.apply(sanitize(patch))
      emit()
      return status
    }) as IpcListener
  )
  deps.ipcMain.handle(
    REMOTE_CHANNELS.regenerateToken,
    guard(async (): Promise<RemoteStatus> => {
      const status = await deps.controller.regenerateToken()
      emit()
      return status
    }) as IpcListener
  )
  deps.ipcMain.handle(
    REMOTE_CHANNELS.clients,
    guard(() => deps.controller.clients()) as IpcListener
  )
  deps.ipcMain.handle(
    REMOTE_CHANNELS.revokeClient,
    guard((_event, token: unknown): boolean => {
      if (typeof token !== 'string') return false
      const revoked = deps.controller.revoke(token)
      emit()
      return revoked
    }) as IpcListener
  )
  deps.ipcMain.handle(
    REMOTE_CHANNELS.interfaces,
    guard(() => deps.bindOptions()) as IpcListener
  )

  return {
    emit,
    dispose(): void {
      for (const channel of Object.values(REMOTE_CHANNELS)) {
        if (channel !== REMOTE_CHANNELS.event) deps.ipcMain.removeHandler(channel)
      }
    }
  }
}

/** Accept only the three writable remote fields from an untrusted renderer payload. */
function sanitize(patch: unknown): { enabled?: boolean; bindAddress?: string; port?: number } {
  const input = (patch ?? {}) as Record<string, unknown>
  const out: { enabled?: boolean; bindAddress?: string; port?: number } = {}
  if (typeof input.enabled === 'boolean') out.enabled = input.enabled
  if (typeof input.bindAddress === 'string') out.bindAddress = input.bindAddress.slice(0, 64)
  if (typeof input.port === 'number' && Number.isInteger(input.port)) out.port = input.port
  return out
}
