import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Like the other window registries, this one is an authorization root for IPC —
 * so it is tested without Electron: a fake BrowserWindow gives us the
 * webContents ↔ workspaceId mapping and the window options.
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
  readonly calls: Array<'show' | 'showInactive' | 'focus' | 'hide' | 'restore'> = []

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
  isVisible(): boolean {
    return this.shown && !this.destroyed
  }
  restore(): void {
    this.minimized = false
    this.calls.push('restore')
  }
  hide(): void {
    this.shown = false
    this.calls.push('hide')
  }
  show(): void {
    this.shown = true
    this.calls.push('show')
  }
  showInactive(): void {
    this.shown = true
    this.calls.push('showInactive')
  }
  focus(): void {
    this.focused = true
    this.calls.push('focus')
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

type TimelineWindowModule = typeof import('./timelineWindow')
let timelineWindow: TimelineWindowModule

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  FakeBrowserWindow.instances = []
  listeners.clear()
  timelineWindow = await import('./timelineWindow')
})

describe('openTimelineWindow', () => {
  it('is a resizable glass sheet that never floats above everything', () => {
    timelineWindow.openTimelineWindow('ws-1')
    const options = FakeBrowserWindow.instances[0]!.options

    expect(options.frame).toBe(false)
    expect(options.transparent).toBe(true)
    expect(options.resizable).toBe(true)
    expect(options.alwaysOnTop).toBe(false)
    expect(options.width).toBe(timelineWindow.TIMELINE_WINDOW_WIDTH)
    expect(options.height).toBe(timelineWindow.TIMELINE_WINDOW_HEIGHT)
    expect(options.minHeight).toBe(timelineWindow.TIMELINE_WINDOW_MIN_HEIGHT)
  })

  it('loads the /timeline/<workspaceId> route and applies the navigation guard', () => {
    const win = timelineWindow.openTimelineWindow('ws-1')
    expect(secureWindow).toHaveBeenCalledWith(win)
    expect(loadRoute).toHaveBeenCalledWith(win, '/timeline/ws-1')
  })

  it('encodes the workspace id in the route', () => {
    timelineWindow.openTimelineWindow('ws/odd')
    expect(loadRoute).toHaveBeenCalledWith(expect.anything(), '/timeline/ws%2Fodd')
  })

  it('is identity on a second open of the same workspace — does not twin', () => {
    const first = timelineWindow.openTimelineWindow('ws-1') as unknown as FakeBrowserWindow
    first.minimized = true

    const again = timelineWindow.openTimelineWindow('ws-1')

    expect(again).toBe(first as unknown as typeof again)
    expect(FakeBrowserWindow.instances).toHaveLength(1)
    expect(first.minimized).toBe(false)
    expect(first.focused).toBe(true)
    expect(first.shown).toBe(true)
  })

  it('opens one window per workspace, not one for the whole app', () => {
    timelineWindow.openTimelineWindow('ws-1')
    timelineWindow.openTimelineWindow('ws-2')

    expect(FakeBrowserWindow.instances).toHaveLength(2)
    expect(timelineWindow.listTimelineWindows().map((entry) => entry.workspaceId).sort()).toEqual([
      'ws-1',
      'ws-2'
    ])
  })

  it('opens a fresh window after the old one was closed', () => {
    timelineWindow.openTimelineWindow('ws-1')
    timelineWindow.closeTimelineWindow('ws-1')
    timelineWindow.openTimelineWindow('ws-1')

    expect(FakeBrowserWindow.instances).toHaveLength(2)
    expect(timelineWindow.listTimelineWindows()).toHaveLength(1)
  })
})

describe('the window registry', () => {
  it('maps a webContents id onto exactly one workspaceId', () => {
    const a = timelineWindow.openTimelineWindow('ws-a')
    const b = timelineWindow.openTimelineWindow('ws-b')

    expect(timelineWindow.isTimelineWindowSender(a.webContents.id)).toBe('ws-a')
    expect(timelineWindow.isTimelineWindowSender(b.webContents.id)).toBe('ws-b')
    expect(timelineWindow.isTimelineWindowSender(a.webContents.id + 99)).toBeNull()
  })

  it('rejects every sender while no timeline is open', () => {
    expect(timelineWindow.isTimelineWindowSender(1)).toBeNull()
    expect(timelineWindow.getTimelineWindow('ws-1')).toBeNull()
    expect(timelineWindow.listTimelineWindows()).toEqual([])
  })

  it('forgets a window once it is closed', () => {
    const win = timelineWindow.openTimelineWindow('ws-1')
    const id = win.webContents.id
    timelineWindow.closeTimelineWindow('ws-1')

    expect(timelineWindow.getTimelineWindow('ws-1')).toBeNull()
    expect(timelineWindow.isTimelineWindowSender(id)).toBeNull()
    expect((win as unknown as FakeBrowserWindow).destroyed).toBe(true)
    expect(timelineWindow.listTimelineWindows()).toEqual([])
  })

  it('prunes a window that was destroyed without firing closed', () => {
    const win = timelineWindow.openTimelineWindow('ws-1')
    ;(win as unknown as FakeBrowserWindow).destroyed = true

    expect(timelineWindow.getTimelineWindow('ws-1')).toBeNull()
    expect(timelineWindow.isTimelineWindowSender(win.webContents.id)).toBeNull()
    expect(timelineWindow.listTimelineWindows()).toEqual([])
  })

  it('shrugs when asked to close a window that is not open', () => {
    expect(() => timelineWindow.closeTimelineWindow('ghost')).not.toThrow()
  })
})

describe('focusTimelineWindow', () => {
  it('hides other timelines and showInactive+focuses this one once', () => {
    const mine = timelineWindow.openTimelineWindow('ws-1') as unknown as FakeBrowserWindow
    const other = timelineWindow.openTimelineWindow('ws-2') as unknown as FakeBrowserWindow
    mine.shown = true
    other.shown = true
    mine.calls.length = 0
    other.calls.length = 0

    timelineWindow.focusTimelineWindow('ws-1')

    expect(other.calls).toEqual(['hide'])
    expect(mine.calls).toEqual(['showInactive', 'focus'])
    expect(FakeBrowserWindow.instances).toHaveLength(2)
    expect(mine.calls.some((call) => call === 'restore')).toBe(false)
  })

  it('reopens a closed sheet instead of leaving the card click dead', () => {
    timelineWindow.openTimelineWindow('ws-1')
    timelineWindow.closeTimelineWindow('ws-1')

    timelineWindow.focusTimelineWindow('ws-1')

    expect(FakeBrowserWindow.instances).toHaveLength(2)
    expect(timelineWindow.getTimelineWindow('ws-1')).not.toBeNull()
  })

  it('never minimizes a timeline', () => {
    const mine = timelineWindow.openTimelineWindow('ws-1') as unknown as FakeBrowserWindow
    timelineWindow.focusTimelineWindow('ws-1')
    expect(mine.minimized).toBe(false)
  })

  it('restores a taskbar-minimized sheet then showInactive+focus; foreign still hide()', () => {
    const mine = timelineWindow.openTimelineWindow('ws-1') as unknown as FakeBrowserWindow
    const other = timelineWindow.openTimelineWindow('ws-2') as unknown as FakeBrowserWindow
    mine.shown = true
    mine.minimized = true
    other.shown = true
    other.minimized = true
    mine.calls.length = 0
    other.calls.length = 0

    timelineWindow.focusTimelineWindow('ws-1')

    expect(mine.minimized).toBe(false)
    expect(mine.calls).toEqual(['restore', 'showInactive', 'focus'])
    expect(other.calls).toEqual(['hide'])
  })
})

describe('the module contract', () => {
  it('never calls minimize and never reads startMinimized', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const source = readFileSync(join(__dirname, 'timelineWindow.ts'), 'utf8')
    expect(source).not.toMatch(/\.minimize\(/)
    expect(source).not.toMatch(/startMinimized/)
    expect(source).toMatch(/glassWindowOptions\(\)/)
    expect(source).toMatch(/secureWindow\(/)
    expect(source).toMatch(/loadRoute\(/)
  })
})

// The sandbox/secureWindow posture of this window is pinned centrally by
// base.securityContract.test.ts, which derives its file list from the directory.
