import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The CLI window registry is the authorization root of the terminal IPC, so it
 * is tested without Electron: a fake BrowserWindow gives us the two properties
 * that matter — the webContents ↔ agent mapping and the window options.
 */
const listeners = new Map<FakeBrowserWindow, Map<string, () => void>>()
let nextWebContentsId = 1

class FakeBrowserWindow {
  static instances: FakeBrowserWindow[] = []
  readonly webContents = { id: nextWebContentsId++ }
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
  minimize(): void {
    this.minimized = true
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

vi.mock('electron', () => ({ BrowserWindow: FakeBrowserWindow }))

const loadRoute = vi.fn()
const secureWindow = vi.fn()
vi.mock('./base', () => ({
  glassWindowOptions: () => ({ frame: false, transparent: true }),
  loadRoute: (...args: unknown[]) => loadRoute(...args),
  secureWindow: (...args: unknown[]) => secureWindow(...args)
}))

type CliWindowModule = typeof import('./cliWindow')
let cli: CliWindowModule

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  FakeBrowserWindow.instances = []
  listeners.clear()
  cli = await import('./cliWindow')
})

describe('createCliWindow', () => {
  it('creates a frameless, resizable glass window that is never always-on-top', () => {
    cli.createCliWindow('agent-1', { title: 'Caronte', roleColor: '#2f7d6d' })
    const options = FakeBrowserWindow.instances[0]!.options

    expect(options.frame).toBe(false)
    expect(options.transparent).toBe(true)
    expect(options.resizable).toBe(true)
    expect(options.alwaysOnTop).toBe(false)
    // Grow/shrink is the title bar's, not the OS's — see createCliWindow.
    expect(options.maximizable).toBe(false)
    expect(options.minWidth).toBe(cli.CLI_MIN_WIDTH)
    expect(options.minHeight).toBe(cli.CLI_MIN_HEIGHT)
    expect(options.title).toBe('Vertragus — Caronte')
  })

  it('loads the agent route and applies the navigation guard', () => {
    const win = cli.createCliWindow('agent 1/x', { title: 'Caronte', roleColor: '#2f7d6d' })
    expect(secureWindow).toHaveBeenCalledWith(win)
    expect(loadRoute).toHaveBeenCalledWith(win, `/agent/${encodeURIComponent('agent 1/x')}`)
  })

  it('honours explicit bounds and falls back to the default size', () => {
    cli.createCliWindow('a', { title: 'A', roleColor: '#000', bounds: { x: 40, y: 60, width: 900 } })
    const options = FakeBrowserWindow.instances[0]!.options
    expect(options).toMatchObject({ x: 40, y: 60, width: 900 })
    expect(options.height).toBe(cli.CLI_DEFAULT_HEIGHT)

    cli.createCliWindow('b', { title: 'B', roleColor: '#000' })
    const second = FakeBrowserWindow.instances[1]!.options
    expect(second.width).toBe(cli.CLI_DEFAULT_WIDTH)
    expect(second.x).toBeUndefined()
  })

  it('reuses and refocuses an existing window instead of opening a second one', () => {
    const first = cli.createCliWindow('agent-1', { title: 'Caronte', roleColor: '#2f7d6d' })
    const again = cli.createCliWindow('agent-1', { title: 'Caronte', roleColor: '#2f7d6d' })
    expect(again).toBe(first)
    expect(FakeBrowserWindow.instances).toHaveLength(1)
    expect((first as unknown as FakeBrowserWindow).focused).toBe(true)
  })
})

describe('CLI window registry', () => {
  it('maps a webContents id to exactly one agent and rejects everything else', () => {
    const a = cli.createCliWindow('agent-a', { title: 'A', roleColor: '#111' })
    const b = cli.createCliWindow('agent-b', { title: 'B', roleColor: '#222' })

    expect(cli.isCliWindowSender(a.webContents.id)).toBe('agent-a')
    expect(cli.isCliWindowSender(b.webContents.id)).toBe('agent-b')
    expect(cli.isCliWindowSender(9999)).toBeNull()
  })

  it('forgets a window once it is closed', () => {
    const win = cli.createCliWindow('agent-a', { title: 'A', roleColor: '#111' })
    const id = win.webContents.id
    expect(cli.listCliWindows().map((entry) => entry.agentId)).toEqual(['agent-a'])

    cli.closeCliWindow('agent-a')

    expect(cli.getCliWindow('agent-a')).toBeNull()
    expect(cli.listCliWindows()).toEqual([])
    expect(cli.isCliWindowSender(id)).toBeNull()
    expect((win as unknown as FakeBrowserWindow).destroyed).toBe(true)
  })

  it('prunes destroyed windows that never fired closed', () => {
    const win = cli.createCliWindow('agent-a', { title: 'A', roleColor: '#111' })
    ;(win as unknown as FakeBrowserWindow).destroyed = true

    expect(cli.getCliWindow('agent-a')).toBeNull()
    expect(cli.listCliWindows()).toEqual([])
  })

  it('notifies listeners when a window is closed', () => {
    const seen: string[] = []
    const off = cli.onCliWindowClosed((agentId) => seen.push(agentId))
    cli.createCliWindow('agent-a', { title: 'A', roleColor: '#111' })
    cli.closeCliWindow('agent-a')
    expect(seen).toEqual(['agent-a'])
    off()
    cli.createCliWindow('agent-b', { title: 'B', roleColor: '#222' })
    cli.closeCliWindow('agent-b')
    expect(seen).toEqual(['agent-a'])
  })

  it('focus restores a minimized window', () => {
    const win = cli.createCliWindow('agent-a', { title: 'A', roleColor: '#111' }) as unknown as FakeBrowserWindow
    win.minimized = true
    cli.focusCliWindow('agent-a')
    expect(win.minimized).toBe(false)
    expect(win.focused).toBe(true)
    expect(() => cli.focusCliWindow('ghost')).not.toThrow()
  })

  it('minimizeCliWindow minimizes without forgetting the registry entry', () => {
    const win = cli.createCliWindow('agent-a', { title: 'A', roleColor: '#111' })

    cli.minimizeCliWindow('agent-a')

    expect((win as unknown as FakeBrowserWindow).minimized).toBe(true)
    expect(cli.getCliWindow('agent-a')).toBe(win)
    expect(cli.isCliWindowSender(win.webContents.id)).toBe('agent-a')
  })

  it('minimizing an unknown agent is a no-op', () => {
    expect(() => cli.minimizeCliWindow('ghost')).not.toThrow()
  })
})

// The sandbox/secureWindow posture of this window is pinned centrally by
// base.securityContract.test.ts, which derives its file list from the directory.
