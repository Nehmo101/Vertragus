import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The updater is tested against a fake `autoUpdater`: what matters is the state
 * machine the panel badge reads, not electron-updater's network layer. The
 * production wiring at the bottom of the module touches Electron and the store,
 * so both are mocked away wholesale.
 */
vi.mock('electron', () => ({
  app: { getVersion: () => '9.9.9', isPackaged: false }
}))
vi.mock('electron-updater', () => ({ autoUpdater: {} }))
const getSettings = vi.fn(() => ({ updateChannel: 'main' as const }))
const setSetting = vi.fn()
vi.mock('@main/store/settings', () => ({
  getSettings: () => getSettings(),
  setSetting: (key: string, value: unknown) => setSetting(key, value)
}))

import {
  applyChannel,
  createUpdater,
  UPDATE_CHECK_INTERVAL_MS,
  type AutoUpdaterPort,
  type UpdateState,
  type UpdaterDeps
} from './updater'

class FakeAutoUpdater implements AutoUpdaterPort {
  autoDownload = false
  autoInstallOnAppQuit = false
  allowPrerelease = false
  channel: string | null = null
  checks = 0
  quitAndInstallCalls: (boolean | undefined)[][] = []
  checkResult: () => Promise<unknown> = async () => undefined
  private readonly handlers = new Map<string, (payload: never) => void>()

  on(event: string, listener: (payload: never) => void): this {
    this.handlers.set(event, listener)
    return this
  }
  emit(event: string, payload?: unknown): void {
    this.handlers.get(event)?.(payload as never)
  }
  async checkForUpdates(): Promise<unknown> {
    this.checks += 1
    return this.checkResult()
  }
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
    this.quitAndInstallCalls.push([isSilent, isForceRunAfter])
  }
}

function harness(overrides: Partial<UpdaterDeps> = {}): {
  updater: ReturnType<typeof createUpdater>
  fake: FakeAutoUpdater
  states: UpdateState[]
  timers: { handler: () => void; ms: number }[]
  cleared: unknown[]
  channel: { value: 'main' | 'stable' }
} {
  const fake = new FakeAutoUpdater()
  const states: UpdateState[] = []
  const timers: { handler: () => void; ms: number }[] = []
  const cleared: unknown[] = []
  const channel = { value: 'main' as 'main' | 'stable' }

  const updater = createUpdater({
    autoUpdater: fake,
    currentVersion: '1.2.3',
    enabled: true,
    readChannel: () => channel.value,
    writeChannel: (next) => {
      channel.value = next
    },
    publish: (state) => states.push({ ...state }),
    setInterval: (handler, ms) => {
      timers.push({ handler, ms })
      return { unref: () => undefined }
    },
    clearInterval: (timer) => cleared.push(timer),
    ...overrides
  })
  return { updater, fake, states, timers, cleared, channel }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('the channel', () => {
  it('maps main to prereleases and stable to tagged releases', () => {
    const fake = new FakeAutoUpdater()

    applyChannel(fake, 'main')
    expect(fake.allowPrerelease).toBe(true)
    expect(fake.channel).toBe('main')

    applyChannel(fake, 'stable')
    expect(fake.allowPrerelease).toBe(false)
    expect(fake.channel).toBe('latest')
  })

  it('is configured from the settings before the first check', () => {
    const { updater, fake, channel } = harness()
    channel.value = 'stable'
    updater.start()

    expect(fake.channel).toBe('latest')
    expect(fake.checks).toBe(1)
  })

  it('persists a switch and re-checks on the new channel', async () => {
    const { updater, fake, channel } = harness()
    updater.start()

    const state = await updater.setChannel('stable')

    expect(channel.value).toBe('stable')
    expect(fake.channel).toBe('latest')
    expect(state.channel).toBe('stable')
    expect(fake.checks).toBe(2)
  })

  it('persists a switch even while updates are off, without touching the updater', async () => {
    const { updater, fake, channel } = harness({ enabled: false })
    updater.start()

    const state = await updater.setChannel('stable')

    expect(channel.value).toBe('stable')
    expect(state.channel).toBe('stable')
    expect(fake.checks).toBe(0)
  })

  it('ignores a channel nobody publishes to', async () => {
    const { updater, channel } = harness()
    updater.start()
    // @ts-expect-error — IPC input is not type-checked; the guard is.
    await updater.setChannel('nightly')
    expect(channel.value).toBe('main')
  })

  it('lets a running download finish on the channel it started from', async () => {
    const { updater, fake } = harness()
    updater.start()
    fake.emit('update-available', { version: '1.3.0' })

    await updater.setChannel('stable')

    expect(updater.state().status).toBe('downloading')
    expect(fake.checks).toBe(1)
  })
})

describe('in a development run', () => {
  it('reports itself as off instead of failing every six hours', () => {
    const { updater, fake, states, timers } = harness({ enabled: false })
    updater.start()

    expect(updater.state().status).toBe('disabled')
    expect(states.at(-1)?.message).toContain('installierten App')
    expect(fake.checks).toBe(0)
    expect(timers).toEqual([])
  })

  it('answers a manual check with the unchanged disabled state', async () => {
    const { updater, fake } = harness({ enabled: false })
    updater.start()

    expect((await updater.check()).status).toBe('disabled')
    expect(fake.checks).toBe(0)
  })
})

describe('the lifecycle the panel badge reads', () => {
  it('checks on boot and every six hours after that', () => {
    const { updater, fake, timers } = harness()
    updater.start()

    expect(fake.checks).toBe(1)
    expect(timers).toHaveLength(1)
    expect(timers[0]!.ms).toBe(UPDATE_CHECK_INTERVAL_MS)

    timers[0]!.handler()
    expect(fake.checks).toBe(2)
  })

  it('starts exactly once, however often the app entry calls it', () => {
    const { updater, fake, timers } = harness()
    updater.start()
    updater.start()

    expect(fake.checks).toBe(1)
    expect(timers).toHaveLength(1)
  })

  it('walks checking → downloading → downloaded and keeps the version', () => {
    const { updater, fake, states } = harness()
    updater.start()

    fake.emit('checking-for-update')
    fake.emit('update-available', { version: '1.4.0' })
    fake.emit('download-progress', { percent: 42.7 })
    fake.emit('update-downloaded', { version: '1.4.0' })

    expect(states.map((state) => state.status)).toEqual([
      'checking',
      'checking',
      'downloading',
      'downloading',
      'downloaded'
    ])
    expect(updater.state()).toMatchObject({
      status: 'downloaded',
      availableVersion: '1.4.0',
      currentVersion: '1.2.3'
    })
    expect(updater.state().progress).toBeUndefined()
  })

  it('clamps a progress percentage that arrives out of range', () => {
    const { updater, fake } = harness()
    updater.start()

    fake.emit('download-progress', { percent: 140 })
    expect(updater.state().progress).toBe(100)
    fake.emit('download-progress', { percent: -3 })
    expect(updater.state().progress).toBe(0)
    fake.emit('download-progress', {})
    expect(updater.state().progress).toBe(0)
  })

  it('reports up-to-date without an offered version', () => {
    const { updater, fake } = harness()
    updater.start()
    fake.emit('update-available', { version: '1.4.0' })
    fake.emit('update-not-available', {})

    expect(updater.state().status).toBe('up-to-date')
    expect(updater.state().availableVersion).toBeUndefined()
  })

  it('turns a failing check into a state instead of a rejected promise', async () => {
    const { updater, fake } = harness()
    fake.checkResult = () => Promise.reject(new Error('GitHub ist nicht erreichbar'))
    updater.start()

    const state = await updater.check()
    expect(state.status).toBe('error')
    expect(state.message).toContain('GitHub')
  })

  it('turns an updater error event into a state', () => {
    const { updater, fake } = harness()
    updater.start()
    fake.emit('error', new Error('signature mismatch'))

    expect(updater.state()).toMatchObject({ status: 'error', message: 'signature mismatch' })
  })

  it('does not re-check away a ready update', async () => {
    const { updater, fake } = harness()
    updater.start()
    fake.emit('update-downloaded', { version: '1.4.0' })

    await updater.check()

    expect(fake.checks).toBe(1)
    expect(updater.state().status).toBe('downloaded')
  })
})

describe('installing', () => {
  it('restarts into the update once it is downloaded', () => {
    const { updater, fake } = harness()
    updater.start()
    fake.emit('update-downloaded', { version: '1.4.0' })

    updater.install()

    expect(fake.quitAndInstallCalls).toEqual([[false, true]])
  })

  it('refuses loudly while nothing is ready', () => {
    const { updater, fake } = harness()
    updater.start()

    expect(() => updater.install()).toThrow(/kein fertig geladenes Update/)
    expect(fake.quitAndInstallCalls).toEqual([])
  })

  it('never installs on its own — the badge is a button, not a countdown', () => {
    const { updater, fake } = harness()
    updater.start()

    fake.emit('update-available', { version: '1.4.0' })
    fake.emit('update-downloaded', { version: '1.4.0' })

    expect(fake.autoDownload).toBe(true)
    expect(fake.quitAndInstallCalls).toEqual([])
  })
})

describe('stop', () => {
  it('disarms the timer so a restarted updater does not check twice', () => {
    const { updater, fake, timers, cleared } = harness()
    updater.start()
    updater.stop()

    expect(cleared).toHaveLength(1)

    updater.start()
    expect(fake.checks).toBe(2)
    expect(timers).toHaveLength(2)
  })
})
