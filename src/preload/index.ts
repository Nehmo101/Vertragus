import { contextBridge } from 'electron'

/**
 * The renderer bridge. Grows with the IPC manifest (M2/M3); starts empty so
 * the security posture (contextIsolation, no node in renderer) is in place
 * from the first commit.
 */
const api = {
  platform: process.platform
}

export type VertragusApi = typeof api

contextBridge.exposeInMainWorld('vertragus', api)
