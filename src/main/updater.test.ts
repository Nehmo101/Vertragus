import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { UpdateState } from '@shared/ipc'

// electron-updater's autoUpdater is an EventEmitter-like object. We replace it
// with a hand-rolled stub that records handlers (so tests can drive the state
// machine by emitting the events updater.ts subscribes to) and exposes the
// action methods as spies. electron.app is stubbed so the module can read a
// deterministic version and report itself as a packaged, self-updatable app.
const h = vi.hoisted(() => {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>()
  const autoUpdater = {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    allowPrerelease: false,
    channel: '',
    checkForUpdates: vi.fn(async () => undefined),
    downloadUpdate: vi.fn(async () => undefined),
    quitAndInstall: vi.fn(),
    on(event: string, cb: (...args: unknown[]) => void) {
      const arr = handlers.get(event) ?? []
      arr.push(cb)
      handlers.set(event, arr)
      return autoUpdater
    }
  }
  const app = { isPackaged: true, getVersion: () => '1.2.3' }
  const emit = (event: string, ...args: unknown[]): void => {
    for (const cb of [...(handlers.get(event) ?? [])]) cb(...args)
  }
  return { autoUpdater, app, emit, handlers }
})

vi.mock('electron', () => ({ app: h.app }))
vi.mock('electron-updater', () => ({ autoUpdater: h.autoUpdater }))
const settings = vi.hoisted(() => new Map<string, unknown>())
vi.mock('@main/config/store', () => ({
  getSetting: (key: string) => settings.get(key),
  setSetting: (key: string, value: unknown) => settings.set(key, value)
}))

import {
  getUpdateState,
  onUpdateState,
  checkForMainUpdate,
  downloadMainUpdate,
  installMainUpdate,
  initializeUpdater,
  readUpdateChannel,
  setUpdateChannel
} from './updater'

// The module keeps a single shared `state` and a one-way `initialized` flag with
// no reset hook, so these tests run as an ordered narrative: the pre-init cases
// come first, then initializeUpdater() is called once, then the transition and
// action cases each set their own precondition by emitting the relevant event.
describe('updater state machine', () => {
  beforeEach(() => {
    h.autoUpdater.checkForUpdates.mockClear()
    h.autoUpdater.downloadUpdate.mockClear()
    h.autoUpdater.quitAndInstall.mockClear()
  })

  it('starts in the idle state with the current app version', () => {
    const state = getUpdateState()
    expect(state.status).toBe('idle')
    expect(state.currentVersion).toBe('1.2.3')
  })

  it('checkForMainUpdate is a no-op before the updater is initialized', async () => {
    const result = await checkForMainUpdate()
    expect(result.status).toBe('idle')
    expect(h.autoUpdater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('initializeUpdater configures autoUpdater, registers handlers, and kicks off a check', () => {
    initializeUpdater()

    expect(h.autoUpdater.autoDownload).toBe(false)
    expect(h.autoUpdater.autoInstallOnAppQuit).toBe(true)
    expect(h.autoUpdater.allowPrerelease).toBe(true)
    expect(h.autoUpdater.channel).toBe('main')

    for (const event of [
      'checking-for-update',
      'update-available',
      'update-not-available',
      'download-progress',
      'update-downloaded',
      'error'
    ]) {
      expect(h.handlers.has(event)).toBe(true)
    }

    // The initial check runs synchronously up to its await, so the underlying
    // method has already been invoked and the state moved to 'checking'.
    expect(h.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(getUpdateState().status).toBe('checking')
  })

  it('is idempotent: a second initializeUpdater call does not re-register handlers', () => {
    const before = h.handlers.get('update-available')?.length ?? 0
    initializeUpdater()
    const after = h.handlers.get('update-available')?.length ?? 0
    expect(after).toBe(before)
    // The guarded early return means no second auto-check fires.
    expect(h.autoUpdater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('notifies onUpdateState subscribers on a transition and stops after unsubscribe', () => {
    const seen: UpdateState['status'][] = []
    const off = onUpdateState((next) => seen.push(next.status))

    h.emit('update-available', { version: '2.0.0' })
    expect(seen).toEqual(['available'])

    off()
    h.emit('update-not-available', { version: '1.2.3' })
    expect(seen).toEqual(['available'])
  })

  it('transitions checking -> available and records the available version', () => {
    h.emit('checking-for-update')
    expect(getUpdateState().status).toBe('checking')

    h.emit('update-available', { version: '3.1.0' })
    const state = getUpdateState()
    expect(state.status).toBe('available')
    expect(state.availableVersion).toBe('3.1.0')
    expect(state.currentVersion).toBe('1.2.3')
  })

  it('transitions to up-to-date when no update is available', () => {
    h.emit('update-not-available', { version: '1.2.3' })
    expect(getUpdateState().status).toBe('up-to-date')
  })

  it('reports download progress clamped to 0..100', () => {
    h.emit('download-progress', { percent: 42 })
    expect(getUpdateState()).toMatchObject({ status: 'downloading', progress: 42 })

    h.emit('download-progress', { percent: 150 })
    expect(getUpdateState().progress).toBe(100)

    h.emit('download-progress', { percent: -10 })
    expect(getUpdateState().progress).toBe(0)
  })

  it('transitions to downloaded', () => {
    h.emit('update-downloaded', { version: '3.1.0' })
    const state = getUpdateState()
    expect(state.status).toBe('downloaded')
    expect(state.availableVersion).toBe('3.1.0')
  })

  it('transitions to error and captures the error message', () => {
    h.emit('error', new Error('boom from feed'))
    const state = getUpdateState()
    expect(state.status).toBe('error')
    expect(state.message).toBe('boom from feed')
    expect(state.progress).toBeUndefined()
  })

  it('checkForMainUpdate moves to checking and calls autoUpdater.checkForUpdates', async () => {
    h.emit('update-available', { version: '3.1.0' })
    const result = await checkForMainUpdate()
    expect(h.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(result.status).toBe('checking')
  })

  it('checkForMainUpdate is skipped while a download is in flight', async () => {
    h.emit('update-downloaded', { version: '3.1.0' })
    const result = await checkForMainUpdate()
    expect(result.status).toBe('downloaded')
    expect(h.autoUpdater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('checkForMainUpdate captures failures from autoUpdater into the error state', async () => {
    h.emit('update-available', { version: '3.1.0' })
    h.autoUpdater.checkForUpdates.mockRejectedValueOnce(new Error('network down'))
    const result = await checkForMainUpdate()
    expect(result.status).toBe('error')
    expect(result.message).toBe('network down')
  })

  it('downloadMainUpdate only runs when an update is available', async () => {
    h.emit('update-not-available', { version: '1.2.3' })
    const result = await downloadMainUpdate()
    expect(result.status).toBe('up-to-date')
    expect(h.autoUpdater.downloadUpdate).not.toHaveBeenCalled()
  })

  it('downloadMainUpdate moves to downloading and calls autoUpdater.downloadUpdate', async () => {
    h.emit('update-available', { version: '3.1.0' })
    const result = await downloadMainUpdate()
    expect(h.autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(result.status).toBe('downloading')
    expect(result.progress).toBe(0)
  })

  it('downloadMainUpdate captures failures into the error state', async () => {
    h.emit('update-available', { version: '3.1.0' })
    h.autoUpdater.downloadUpdate.mockRejectedValueOnce(new Error('disk full'))
    const result = await downloadMainUpdate()
    expect(result.status).toBe('error')
    expect(result.message).toBe('disk full')
    expect(result.progress).toBeUndefined()
  })

  it('installMainUpdate throws when the update is not fully downloaded', () => {
    h.emit('update-available', { version: '3.1.0' })
    expect(() => installMainUpdate()).toThrow(/noch nicht/)
    expect(h.autoUpdater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('installMainUpdate calls quitAndInstall once the update is downloaded', () => {
    h.emit('update-downloaded', { version: '3.1.0' })
    installMainUpdate()
    expect(h.autoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true)
  })
})

describe('update channel', () => {
  it('defaults to the fast main channel', () => {
    expect(readUpdateChannel()).toBe('main')
  })

  it('setUpdateChannel(stable) persists the choice, tracks tagged releases only, and re-checks', async () => {
    h.emit('update-not-available', { version: '1.2.3' })
    const result = await setUpdateChannel('stable')

    expect(readUpdateChannel()).toBe('stable')
    expect(h.autoUpdater.allowPrerelease).toBe(false)
    expect(h.autoUpdater.channel).toBe('latest')
    expect(h.autoUpdater.checkForUpdates).toHaveBeenCalled()
    expect(result.channel).toBe('stable')
  })

  it('switching back to main restores prerelease tracking on the main channel file', async () => {
    h.emit('update-not-available', { version: '1.2.3' })
    await setUpdateChannel('main')

    expect(readUpdateChannel()).toBe('main')
    expect(h.autoUpdater.allowPrerelease).toBe(true)
    expect(h.autoUpdater.channel).toBe('main')
  })
})

// The unsupported branch depends on module-load state (isPackaged) and the
// one-way `initialized` flag, so it needs a freshly evaluated module instance.
describe('initializeUpdater on unsupported environments', () => {
  it('marks the state unsupported when the app is not packaged', async () => {
    vi.resetModules()
    h.app.isPackaged = false
    try {
      const mod = await import('./updater')
      mod.initializeUpdater()
      const state = mod.getUpdateState()
      expect(state.status).toBe('unsupported')
      expect(state.message).toMatch(/installierten App/)
    } finally {
      h.app.isPackaged = true
    }
  })
})
