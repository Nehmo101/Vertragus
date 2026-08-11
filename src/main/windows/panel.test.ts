import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The panel window registry is an authorization root for the app IPC (only the
 * panel may drive workspaces, settings and the quit dialog), and since the
 * hover fix it also owns a poller. Both are tested here without Electron: a
 * fake BrowserWindow gives us the options, the webContents ↔ window mapping and
 * every lifecycle event the tracker hangs off.
 */
const listeners = new Map<FakeBrowserWindow, Map<string, (() => void)[]>>()
let nextWebContentsId = 1

class FakeWebContents {
  readonly id = nextWebContentsId++
  readonly sent: { channel: string; payload: unknown }[] = []
  readonly handlers = new Map<string, (() => void)[]>()
  destroyed = false

  on(event: string, handler: () => void): this {
    const list = this.handlers.get(event) ?? []
    list.push(handler)
    this.handlers.set(event, list)
    return this
  }
  emit(event: string): void {
    for (const handler of this.handlers.get(event) ?? []) handler()
  }
  send(channel: string, payload: unknown): void {
    this.sent.push({ channel, payload })
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
}

class FakeBrowserWindow {
  static instances: FakeBrowserWindow[] = []
  readonly webContents = new FakeWebContents()
  destroyed = false
  visible = false
  bounds: { x: number; y: number; width: number; height: number }
  alwaysOnTopLevel: string | undefined

  constructor(public readonly options: Record<string, unknown>) {
    FakeBrowserWindow.instances.push(this)
    listeners.set(this, new Map())
    this.bounds = {
      x: options.x as number,
      y: options.y as number,
      width: options.width as number,
      height: options.height as number
    }
  }

  on(event: string, handler: () => void): this {
    const map = listeners.get(this)!
    const list = map.get(event) ?? []
    list.push(handler)
    map.set(event, list)
    return this
  }
  emit(event: string): void {
    for (const handler of listeners.get(this)?.get(event) ?? []) handler()
  }
  setAlwaysOnTop(_flag: boolean, level?: string): void {
    this.alwaysOnTopLevel = level
  }
  show(): void {
    this.visible = true
    this.emit('show')
  }
  hide(): void {
    this.visible = false
    this.emit('hide')
  }
  focus(): void {}
  isVisible(): boolean {
    return this.visible
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  getBounds(): { x: number; y: number; width: number; height: number } {
    return this.bounds
  }
  close(): void {
    this.destroyed = true
    this.emit('closed')
  }
}

const cursor = { x: 0, y: 0 }

vi.mock('electron', () => ({
  BrowserWindow: FakeBrowserWindow,
  screen: {
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
    getCursorScreenPoint: () => ({ ...cursor })
  }
}))

const loadRoute = vi.fn()
const secureWindow = vi.fn()
vi.mock('./base', () => ({
  glassWindowOptions: () => ({ frame: false, transparent: true, show: false }),
  loadRoute: (...args: unknown[]) => loadRoute(...args),
  secureWindow: (...args: unknown[]) => secureWindow(...args)
}))

type PanelModule = typeof import('./panel')
let panel: PanelModule

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.useFakeTimers()
  FakeBrowserWindow.instances = []
  listeners.clear()
  cursor.x = 0
  cursor.y = 0
  panel = await import('./panel')
})

function pointerEvents(win: FakeBrowserWindow): unknown[] {
  return win.webContents.sent.filter((entry) => entry.channel === 'panel:pointer').map((e) => e.payload)
}

describe('createPanelWindow', () => {
  it('docks a frameless always-on-top strip to the right edge of the work area', () => {
    panel.createPanelWindow()
    const win = FakeBrowserWindow.instances[0]!

    expect(win.options.frame).toBe(false)
    expect(win.options.transparent).toBe(true)
    expect(win.options.resizable).toBe(false)
    expect(win.options.alwaysOnTop).toBe(true)
    expect(win.alwaysOnTopLevel).toBe('floating')
    expect(win.options.width).toBe(panel.PANEL_WIDTH)
    expect(win.options.x).toBe(1920 - panel.PANEL_WIDTH - panel.PANEL_MARGIN)
    expect(loadRoute).toHaveBeenCalledWith(win, '/panel')
    expect(secureWindow).toHaveBeenCalledWith(win)
  })

  it('reuses the one panel instead of opening a second', () => {
    const first = panel.createPanelWindow()
    expect(panel.createPanelWindow()).toBe(first)
    expect(FakeBrowserWindow.instances).toHaveLength(1)
  })

  it('maps its webContents id and forgets the window when it closes', () => {
    const win = panel.createPanelWindow() as unknown as FakeBrowserWindow

    expect(panel.isPanelWindowSender(win.webContents.id)).toBe(true)
    expect(panel.isPanelWindowSender(win.webContents.id + 999)).toBe(false)

    win.close()
    expect(panel.getPanelWindow()).toBeNull()
    expect(panel.isPanelWindowSender(win.webContents.id)).toBe(false)
  })
})

describe('pointer tracking (the drag-region hover fix)', () => {
  it('pushes "inside" as soon as the cursor is over the shown panel', () => {
    const win = panel.createPanelWindow() as unknown as FakeBrowserWindow
    win.emit('ready-to-show')
    expect(pointerEvents(win)).toEqual([{ inside: false }])

    cursor.x = win.bounds.x + 40
    cursor.y = win.bounds.y + 40
    vi.advanceTimersByTime(400)
    expect(pointerEvents(win).at(-1)).toEqual({ inside: true })

    cursor.x = 10
    vi.advanceTimersByTime(400)
    expect(pointerEvents(win).at(-1)).toEqual({ inside: false })
  })

  it('polls only while the panel is visible', () => {
    const win = panel.createPanelWindow() as unknown as FakeBrowserWindow
    win.emit('ready-to-show')
    win.hide()
    cursor.x = win.bounds.x + 40
    cursor.y = win.bounds.y + 40
    vi.advanceTimersByTime(1_000)

    // Hidden: no polling at all, so the cursor sitting inside changes nothing.
    expect(pointerEvents(win)).toEqual([{ inside: false }])

    win.show()
    expect(pointerEvents(win).at(-1)).toEqual({ inside: true })
  })

  it('stops polling once the window is closed', () => {
    const win = panel.createPanelWindow() as unknown as FakeBrowserWindow
    win.emit('ready-to-show')
    win.close()
    cursor.x = win.bounds.x + 40
    cursor.y = win.bounds.y + 40
    vi.advanceTimersByTime(1_000)

    // Nothing more arrives however long the cursor rests inside: the interval
    // is gone, not merely ignored.
    expect(pointerEvents(win)).toEqual([{ inside: false }])
  })

  it('re-pushes the state after the renderer reloaded', () => {
    const win = panel.createPanelWindow() as unknown as FakeBrowserWindow
    win.emit('ready-to-show')
    cursor.x = win.bounds.x + 40
    cursor.y = win.bounds.y + 40
    vi.advanceTimersByTime(400)
    const before = pointerEvents(win).length

    win.webContents.emit('did-finish-load')
    expect(pointerEvents(win)).toHaveLength(before + 1)
    expect(pointerEvents(win).at(-1)).toEqual({ inside: true })
  })
})
