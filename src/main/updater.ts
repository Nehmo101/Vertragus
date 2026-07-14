import { app } from 'electron'
import { autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater'
import type { UpdateState } from '@shared/ipc'

const UPDATE_CHANNEL = 'main'
const CHECK_INTERVAL_MS = 30 * 60 * 1_000

let initialized = false
let state: UpdateState = {
  status: 'idle',
  currentVersion: app.getVersion()
}
const listeners = new Set<(next: UpdateState) => void>()

function publish(next: UpdateState): void {
  state = next
  for (const listener of listeners) listener(state)
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function withVersion(status: UpdateState['status'], info?: UpdateInfo): UpdateState {
  return {
    status,
    currentVersion: app.getVersion(),
    availableVersion: info?.version
  }
}

export function getUpdateState(): UpdateState {
  return state
}

export function onUpdateState(listener: (next: UpdateState) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export async function checkForMainUpdate(): Promise<UpdateState> {
  if (!initialized || !app.isPackaged) return state
  if (state.status === 'downloading' || state.status === 'downloaded') return state

  publish(withVersion('checking'))
  try {
    await autoUpdater.checkForUpdates()
  } catch (error) {
    publish({
      status: 'error',
      currentVersion: app.getVersion(),
      message: messageFrom(error)
    })
  }
  return state
}

export async function downloadMainUpdate(): Promise<UpdateState> {
  if (state.status !== 'available') return state
  publish({ ...state, status: 'downloading', progress: 0 })
  try {
    await autoUpdater.downloadUpdate()
  } catch (error) {
    publish({
      ...state,
      status: 'error',
      message: messageFrom(error),
      progress: undefined
    })
  }
  return state
}

export function installMainUpdate(): void {
  if (state.status !== 'downloaded') {
    throw new Error('Das Main-Update wurde noch nicht vollständig heruntergeladen.')
  }
  autoUpdater.quitAndInstall(false, true)
}

export function initializeUpdater(): void {
  if (initialized) return
  initialized = true

  if (!app.isPackaged || !['win32', 'darwin', 'linux'].includes(process.platform)) {
    publish({
      status: 'unsupported',
      currentVersion: app.getVersion(),
      message: app.isPackaged
        ? 'Self-Updates werden auf dieser Plattform nicht unterstützt.'
        : 'Self-Updates sind nur in einer installierten App aktiv.'
    })
    return
  }

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowPrerelease = true
  autoUpdater.channel = UPDATE_CHANNEL

  autoUpdater.on('checking-for-update', () => publish(withVersion('checking')))
  autoUpdater.on('update-available', (info) => publish(withVersion('available', info)))
  autoUpdater.on('update-not-available', (info) => publish(withVersion('up-to-date', info)))
  autoUpdater.on('download-progress', (progress: ProgressInfo) => {
    publish({
      ...state,
      status: 'downloading',
      progress: Math.max(0, Math.min(100, progress.percent))
    })
  })
  autoUpdater.on('update-downloaded', (info) => publish(withVersion('downloaded', info)))
  autoUpdater.on('error', (error) => {
    publish({
      ...state,
      status: 'error',
      message: messageFrom(error),
      progress: undefined
    })
  })

  void checkForMainUpdate()
  const timer = setInterval(() => void checkForMainUpdate(), CHECK_INTERVAL_MS)
  timer.unref()
}
