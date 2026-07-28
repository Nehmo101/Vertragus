/**
 * Preload bridge. The `window.vertragus` API is built generically from the
 * declarative channel manifest (src/shared/ipcManifest.ts): `invoke` entries
 * become `ipcRenderer.invoke` pass-throughs, `send` entries one-way
 * `ipcRenderer.send` calls, `event` entries subscriptions returning an
 * unsubscribe function. Only the manifest entries marked `bridge: 'custom'`
 * are written by hand below (argument transforms and preload-local members) —
 * the renderer-visible API shape is exactly `VertragusApi`, unchanged.
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { IPC } from '@shared/ipc'
import {
  buildVertragusApi,
  type CustomBridgeBindings,
  type IpcTransport
} from '@shared/ipcManifest'
import { assertValidConfigKey } from '@shared/ipcValidation'

const transport: IpcTransport = {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  send: (channel, ...args) => ipcRenderer.send(channel, ...args),
  subscribe: (channel, cb) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: unknown): void => cb(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
}

/**
 * The documented special cases (manifest `bridge: 'custom'`):
 *  - configGet/configSet fail fast on invalid keys before crossing the bridge
 *    (the main process re-validates regardless),
 *  - abortPromptEnhancement wraps the bare requestId into the controller's
 *    `{ requestId }` request shape,
 *  - files.pathForFile never crosses IPC (Electron webUtils, preload-local).
 */
const customBindings: CustomBridgeBindings = {
  configGet: (key) => ipcRenderer.invoke(IPC.configGet, assertValidConfigKey(key)),
  configSet: (key, value) => ipcRenderer.invoke(IPC.configSet, assertValidConfigKey(key), value),
  ideasAbortPromptEnhancement: (requestId) =>
    ipcRenderer.invoke(IPC.ideasAbortPromptEnhancement, { requestId }),
  filesPathForFile: (file) => webUtils.getPathForFile(file)
}

const vertragus = buildVertragusApi(transport, customBindings)

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('vertragus', vertragus)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-expect-error fallback when context isolation is disabled
  window.electron = electronAPI
  // @ts-expect-error fallback when context isolation is disabled
  window.vertragus = vertragus
}
