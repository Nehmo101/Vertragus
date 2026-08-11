import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Like the other window registries, this one is an authorization root for IPC —
 * so it is tested without Electron: a fake BrowserWindow gives us the
 * webContents ↔ "is the settings window" mapping and the window options.
 */
const listeners = new Map<FakeBrowserWindow, Map<string, () => void>>()
let nextWebContentsId = 1

class FakeBrowserWindow {
  static instances: FakeBrowserWindow[] = []
  readonly webContents = { id: nextWebContentsId++, once: vi.fn() }
  destroyed = false
  shown = false
  focused = false
  minimized = false

  constructor(public readonly options: Record<string, unknown>) {
    FakeBrowserWindow.instances.push(this)
    listeners.set(this, new Map())
  }

  on(event: string, handler: () => void): this {
    listeners.get(this)!.set(event, handler)
    return this
  }
  emit(event: string): void {
    listeners.get(this)?.get(event)?.()
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  isMinimized(): boolean {
    return this.minimized
  }
  restore(): void {
    this.minimized = false
  }
  show(): void {
    this.shown = true
  }
  focus(): void {
    this.focused = true
  }
  close(): void {
    this.destroyed = true
    this.emit('closed')
  }
}

vi.mock('electron', () => ({ BrowserWindow: FakeBrowserWindow, app: { exit: vi.fn() } }))

const loadRoute = vi.fn()
const secureWindow = vi.fn()
vi.mock('./base', () => ({
  glassWindowOptions: () => ({ frame: false, transparent: true }),
  loadRoute: (...args: unknown[]) => loadRoute(...args),
  secureWindow: (...args: unknown[]) => secureWindow(...args)
}))

type SettingsWindowModule = typeof import('./settingsWindow')
let settingsWindow: SettingsWindowModule

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  FakeBrowserWindow.instances = []
  listeners.clear()
  settingsWindow = await import('./settingsWindow')
})

describe('openSettingsWindow', () => {
  it('is a resizable glass sheet that never floats above everything', () => {
    settingsWindow.openSettingsWindow()
    const options = FakeBrowserWindow.instances[0]!.options

    expect(options.frame).toBe(false)
    expect(options.transparent).toBe(true)
    expect(options.resizable).toBe(true)
    expect(options.alwaysOnTop).toBe(false)
    expect(options.width).toBe(settingsWindow.SETTINGS_WINDOW_WIDTH)
    expect(options.minHeight).toBe(settingsWindow.SETTINGS_WINDOW_MIN_HEIGHT)
  })

  it('loads the /settings route and applies the navigation guard', () => {
    const win = settingsWindow.openSettingsWindow()
    expect(secureWindow).toHaveBeenCalledWith(win)
    expect(loadRoute).toHaveBeenCalledWith(win, '/settings')
  })

  it('refocuses the one window instead of opening a second view of one record', () => {
    const first = settingsWindow.openSettingsWindow() as unknown as FakeBrowserWindow
    first.minimized = true

    const again = settingsWindow.openSettingsWindow()

    expect(again).toBe(first as unknown as typeof again)
    expect(FakeBrowserWindow.instances).toHaveLength(1)
    expect(first.minimized).toBe(false)
    expect(first.focused).toBe(true)
    expect(first.shown).toBe(true)
  })

  it('opens a fresh window after the old one was closed', () => {
    settingsWindow.openSettingsWindow()
    settingsWindow.closeSettingsWindow()
    settingsWindow.openSettingsWindow()

    expect(FakeBrowserWindow.instances).toHaveLength(2)
    expect(settingsWindow.listSettingsWindows()).toHaveLength(1)
  })
})

describe('the window registry', () => {
  it('maps exactly one webContents id and rejects every other sender', () => {
    const win = settingsWindow.openSettingsWindow()

    expect(settingsWindow.isSettingsWindowSender(win.webContents.id)).toBe(true)
    expect(settingsWindow.isSettingsWindowSender(win.webContents.id + 1)).toBe(false)
  })

  it('rejects every sender while no settings window is open', () => {
    expect(settingsWindow.isSettingsWindowSender(1)).toBe(false)
    expect(settingsWindow.getSettingsWindow()).toBeNull()
    expect(settingsWindow.listSettingsWindows()).toEqual([])
  })

  it('forgets a window once it is closed', () => {
    const win = settingsWindow.openSettingsWindow()
    const id = win.webContents.id
    settingsWindow.closeSettingsWindow()

    expect(settingsWindow.getSettingsWindow()).toBeNull()
    expect(settingsWindow.isSettingsWindowSender(id)).toBe(false)
    expect((win as unknown as FakeBrowserWindow).destroyed).toBe(true)
  })

  it('prunes a window that was destroyed without firing closed', () => {
    const win = settingsWindow.openSettingsWindow()
    ;(win as unknown as FakeBrowserWindow).destroyed = true

    expect(settingsWindow.getSettingsWindow()).toBeNull()
    expect(settingsWindow.isSettingsWindowSender(win.webContents.id)).toBe(false)
    expect(settingsWindow.listSettingsWindows()).toEqual([])
  })

  it('shrugs when asked to close a window that is not open', () => {
    expect(() => settingsWindow.closeSettingsWindow()).not.toThrow()
  })

  it('offers itself to hide-all under a stable key', () => {
    settingsWindow.openSettingsWindow()
    expect(settingsWindow.listSettingsWindows().map((entry) => entry.key)).toEqual([
      settingsWindow.SETTINGS_WINDOW_KEY
    ])
  })
})

describe('the smoke hook', () => {
  it('stays a no-op without its env variable', () => {
    settingsWindow.armSettingsWindowSmoke()
    expect(FakeBrowserWindow.instances).toEqual([])
  })

  it('opens the sheet when the capture path is set', () => {
    process.env.VERTRAGUS_SETTINGS_SCREENSHOT = 'settings.png'
    try {
      settingsWindow.armSettingsWindowSmoke()
      expect(FakeBrowserWindow.instances).toHaveLength(1)
    } finally {
      delete process.env.VERTRAGUS_SETTINGS_SCREENSHOT
    }
  })
})

describe('security posture', () => {
  it('never weakens the sandbox flags', () => {
    const source = readFileSync(join(__dirname, 'settingsWindow.ts'), 'utf8')
    expect(source).not.toMatch(/sandbox:\s*false/)
    expect(source).not.toMatch(/contextIsolation:\s*false/)
    expect(source).not.toMatch(/nodeIntegration:\s*true/)
    expect(source).not.toMatch(/webSecurity:\s*false/)
    expect(source).toMatch(/glassWindowOptions\(\)/)
    expect(source).toMatch(/secureWindow\(win\)/)
  })
})
