/**
 * Self-update.
 *
 * Vertragus ships from `main`: every green build of the branch becomes a
 * GitHub prerelease on the `main` channel, and tags become normal releases on
 * `latest`. An installed app follows exactly one of the two — `updateChannel`
 * in the settings decides which, defaulting to `main` because that is where
 * fixes actually appear.
 *
 * Three rules the panel badge depends on:
 *
 * 1. **Dev is inert.** `electron-updater` in an unpackaged app throws on the
 *    first check ("dev-app-update.yml not found"). Instead of catching that
 *    every six hours, the updater reports `disabled` once and never arms a
 *    timer. Nothing in the UI lies about being up to date.
 * 2. **Download is automatic, install never is.** The badge appears only on
 *    `update-downloaded` and says "Neustart" — restarting a window full of
 *    running agents is the user's decision, never a background task's.
 * 3. **Every failure is a state, not a throw.** A GitHub outage must show up as
 *    a quiet error state; it must not reject a boot or an IPC call.
 *
 * `createUpdater(deps)` is the testable core (the real `autoUpdater` is a
 * dependency), the exports below it are the app-wide singleton.
 */
import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import { getSettings, setSetting, type UpdateChannel } from '@main/store/settings'

/** Six hours: often enough for a day of work, rare enough to be invisible. */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000

export type UpdateStatus =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'error'

export interface UpdateState {
  status: UpdateStatus
  currentVersion: string
  /** The version waiting to be installed; set from `available` onwards. */
  availableVersion?: string
  channel: UpdateChannel
  /** 0–100 while downloading. */
  progress?: number
  /** Why the last attempt failed, or why updates are off in this build. */
  message?: string
}

/** The slice of electron-updater this module uses. */
export interface AutoUpdaterPort {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowPrerelease: boolean
  channel: string | null
  on(event: string, listener: (payload: never) => void): unknown
  checkForUpdates(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

export interface UpdaterDeps {
  autoUpdater: AutoUpdaterPort
  currentVersion: string
  /** False in dev and in anything that is not an installed app. */
  enabled: boolean
  readChannel(): UpdateChannel
  writeChannel(channel: UpdateChannel): void
  /** Push to the panel. Called on every state change, including the first. */
  publish(state: UpdateState): void
  /** Injectable so the test does not wait six hours. */
  setInterval?(handler: () => void, ms: number): { unref?(): void }
  clearInterval?(timer: unknown): void
}

export interface Updater {
  /** Configure the channel, subscribe, check once, arm the 6 h timer. */
  start(): void
  state(): UpdateState
  /** Manual check; a no-op unless the updater is enabled and idle. */
  check(): Promise<UpdateState>
  /** Persist a channel change and re-check on the new channel. */
  setChannel(channel: UpdateChannel): Promise<UpdateState>
  /** Restart into the downloaded update. Throws while nothing is ready. */
  install(): void
  stop(): void
}

/** `main` = every green main build (prereleases), `stable` = tags only. */
export function applyChannel(target: AutoUpdaterPort, channel: UpdateChannel): void {
  target.allowPrerelease = channel === 'main'
  target.channel = channel === 'main' ? 'main' : 'latest'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createUpdater(deps: UpdaterDeps): Updater {
  const arm = deps.setInterval ?? ((handler, ms) => setInterval(handler, ms))
  const disarm = deps.clearInterval ?? ((timer) => clearInterval(timer as never))

  let started = false
  let timer: unknown
  let state: UpdateState = {
    status: deps.enabled ? 'idle' : 'disabled',
    currentVersion: deps.currentVersion,
    channel: deps.readChannel()
  }

  const publish = (next: Partial<UpdateState>): UpdateState => {
    state = { ...state, ...next }
    deps.publish(state)
    return state
  }

  const check = async (): Promise<UpdateState> => {
    if (!deps.enabled || !started) return state
    // A finished download is terminal until the app restarts; re-checking
    // would flip the badge back to "checking" and lose the ready update.
    if (state.status === 'downloading' || state.status === 'downloaded') return state
    publish({ status: 'checking', message: undefined })
    try {
      await deps.autoUpdater.checkForUpdates()
    } catch (error) {
      publish({ status: 'error', message: messageOf(error) })
    }
    return state
  }

  return {
    state: () => state,
    check,

    start() {
      if (started) return
      if (!deps.enabled) {
        publish({
          status: 'disabled',
          message: 'Self-Updates laufen nur in der installierten App.'
        })
        return
      }
      started = true

      // Download without asking, install never without asking: see the header.
      deps.autoUpdater.autoDownload = true
      deps.autoUpdater.autoInstallOnAppQuit = true
      applyChannel(deps.autoUpdater, deps.readChannel())

      deps.autoUpdater.on('checking-for-update', () => publish({ status: 'checking' }))
      deps.autoUpdater.on('update-available', (info: { version?: string }) =>
        publish({ status: 'downloading', availableVersion: info?.version, progress: 0 })
      )
      deps.autoUpdater.on('update-not-available', () =>
        publish({ status: 'up-to-date', availableVersion: undefined, progress: undefined })
      )
      deps.autoUpdater.on('download-progress', (progress: { percent?: number }) =>
        publish({
          status: 'downloading',
          progress: Math.max(0, Math.min(100, progress?.percent ?? 0))
        })
      )
      deps.autoUpdater.on('update-downloaded', (info: { version?: string }) =>
        publish({
          status: 'downloaded',
          availableVersion: info?.version ?? state.availableVersion,
          progress: undefined
        })
      )
      deps.autoUpdater.on('error', (error: unknown) =>
        publish({ status: 'error', message: messageOf(error), progress: undefined })
      )

      void check()
      timer = arm(() => void check(), UPDATE_CHECK_INTERVAL_MS)
      ;(timer as { unref?(): void }).unref?.()
    },

    async setChannel(channel) {
      if (channel !== 'main' && channel !== 'stable') return state
      deps.writeChannel(channel)
      if (!deps.enabled || !started) return publish({ channel })
      applyChannel(deps.autoUpdater, channel)
      publish({ channel })
      // A download already in flight keeps running; it finishes on the channel
      // it started from, and the new one applies to the next check.
      if (state.status === 'downloading' || state.status === 'downloaded') return state
      return check()
    },

    install() {
      if (state.status !== 'downloaded') {
        throw new Error('Es liegt kein fertig geladenes Update bereit.')
      }
      deps.autoUpdater.quitAndInstall(false, true)
    },

    stop() {
      if (timer !== undefined) disarm(timer)
      timer = undefined
      started = false
    }
  }
}

// --- production wiring ---------------------------------------------------

let instance: Updater | undefined
const listeners = new Set<(state: UpdateState) => void>()

/** Subscribe to update state. Used by appIpc to push `ev:update` to the panel. */
export function onUpdateState(listener: (state: UpdateState) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function readChannelSafely(): UpdateChannel {
  try {
    return getSettings().updateChannel
  } catch {
    // An unreadable config must not decide that there are no updates.
    return 'main'
  }
}

export function appUpdater(): Updater {
  if (!instance) {
    instance = createUpdater({
      autoUpdater: autoUpdater as unknown as AutoUpdaterPort,
      currentVersion: app.getVersion(),
      enabled: app.isPackaged,
      readChannel: readChannelSafely,
      writeChannel: (channel) => {
        setSetting('updateChannel', channel)
      },
      publish: (state) => {
        for (const listener of listeners) listener(state)
      }
    })
  }
  return instance
}

/** Called once after `app.whenReady()`. Inert in dev. */
export function startAppUpdater(): void {
  appUpdater().start()
}

/** Test seam / restart support. */
export function resetUpdaterForTesting(): void {
  instance?.stop()
  instance = undefined
  listeners.clear()
}
