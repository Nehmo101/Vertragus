import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Like the other window registries, the overlay registry is an authorization
 * root for IPC, so it is tested without Electron: fake displays and fake
 * windows give us the two things that matter — one overlay per monitor sized to
 * its work area, and the webContents ↔ (profile, display) mapping.
 */
const listeners = new Map<FakeBrowserWindow, Map<string, () => void>>()
let nextWebContentsId = 1

class FakeBrowserWindow {
  static instances: FakeBrowserWindow[] = []
  readonly inputHandlers: ((event: unknown, input: { type: string; key: string }) => void)[] = []
  readonly webContents = {
    id: nextWebContentsId++,
    once: vi.fn(),
    on: (event: string, handler: (event: unknown, input: { type: string; key: string }) => void) => {
      if (event === 'before-input-event') this.inputHandlers.push(handler)
    }
  }
  destroyed = false
  shown = false
  focused = false
  alwaysOnTop: [boolean, string] | undefined

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
  setAlwaysOnTop(flag: boolean, level: string): void {
    this.alwaysOnTop = [flag, level]
  }
  isDestroyed(): boolean {
    return this.destroyed
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

const DISPLAYS = [
  { id: 11, workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
  { id: 22, workArea: { x: 1920, y: 100, width: 1600, height: 860 } }
]

vi.mock('electron', () => ({
  BrowserWindow: FakeBrowserWindow,
  app: { exit: vi.fn() },
  screen: {
    getAllDisplays: () => DISPLAYS,
    getPrimaryDisplay: () => DISPLAYS[0]
  }
}))

const loadRoute = vi.fn()
const secureWindow = vi.fn()
vi.mock('./base', () => ({
  glassWindowOptions: () => ({ frame: false, transparent: true, show: false }),
  loadRoute: (...args: unknown[]) => loadRoute(...args),
  secureWindow: (...args: unknown[]) => secureWindow(...args)
}))

type OverlayModule = typeof import('./zoneOverlay')
let overlay: OverlayModule

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  FakeBrowserWindow.instances = []
  listeners.clear()
  overlay = await import('./zoneOverlay')
})

describe('openZoneOverlayWindows', () => {
  it('opens one transparent sheet per display, sized to its work area', () => {
    overlay.openZoneOverlayWindows('p1')
    const [first, second] = FakeBrowserWindow.instances

    expect(FakeBrowserWindow.instances).toHaveLength(2)
    expect(first!.options).toMatchObject({
      frame: false,
      transparent: true,
      x: 0,
      y: 0,
      width: 1920,
      height: 1040,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      alwaysOnTop: true
    })
    expect(second!.options).toMatchObject({ x: 1920, y: 100, width: 1600, height: 860 })
    expect(first!.alwaysOnTop).toEqual([true, 'screen-saver'])
  })

  it('loads the display’s route with the profile and guards navigation', () => {
    const [win] = overlay.openZoneOverlayWindows('profile 1/x')

    expect(secureWindow).toHaveBeenCalledWith(win)
    expect(loadRoute).toHaveBeenCalledWith(
      win,
      `/zones/11?profile=${encodeURIComponent('profile 1/x')}&pick=1`
    )
    expect(loadRoute).toHaveBeenCalledWith(
      expect.anything(),
      '/zones/22?profile=profile%201%2Fx&pick=1'
    )
  })

  it('adds the demo flag only when asked and skips the picker (the screenshot hook)', () => {
    overlay.openZoneOverlayWindows('demo', { demo: true })
    expect(loadRoute).toHaveBeenCalledWith(expect.anything(), '/zones/11?profile=demo&demo=1')
    expect(overlay.isZoneOverlaySender(FakeBrowserWindow.instances[0]!.webContents.id)?.pick).toBe(
      false
    )
  })

  it('refocuses a running session instead of opening a second one', () => {
    const first = overlay.openZoneOverlayWindows('p1')
    const again = overlay.openZoneOverlayWindows('p2')

    expect(FakeBrowserWindow.instances).toHaveLength(2)
    expect(again).toEqual(first)
    expect((first[0] as unknown as FakeBrowserWindow).focused).toBe(true)
    // The session keeps the profile it was opened for.
    expect(overlay.isZoneOverlaySender(first[0]!.webContents.id)?.profileId).toBe('p1')
  })

  it('shows each window once it is ready', () => {
    overlay.openZoneOverlayWindows('p1')
    for (const win of FakeBrowserWindow.instances) {
      win.emit('ready-to-show')
      expect(win.shown).toBe(true)
    }
    // Only the primary display's overlay takes focus.
    expect(FakeBrowserWindow.instances[0]!.focused).toBe(true)
    expect(FakeBrowserWindow.instances[1]!.focused).toBe(false)
  })
})

describe('the overlay registry', () => {
  it('maps a webContents id to exactly one profile/display pair', () => {
    const [a, b] = overlay.openZoneOverlayWindows('p1')

    expect(overlay.isZoneOverlaySender(a!.webContents.id)).toEqual({
      profileId: 'p1',
      displayId: 11,
      pick: true
    })
    expect(overlay.isZoneOverlaySender(b!.webContents.id)).toEqual({
      profileId: 'p1',
      displayId: 22,
      pick: true
    })
    expect(overlay.zoneOverlayDisplayIds()).toEqual([11, 22])
  })

  it('rejects every other window — no zone writes from the panel or a CLI', () => {
    overlay.openZoneOverlayWindows('p1')
    expect(overlay.isZoneOverlaySender(9999)).toBeNull()
  })

  it('knows nothing before a session and nothing after it', () => {
    expect(overlay.isZoneOverlaySender(1)).toBeNull()
    expect(overlay.zoneOverlayDisplayIds()).toEqual([])

    const [a] = overlay.openZoneOverlayWindows('p1')
    const id = a!.webContents.id
    overlay.closeZoneOverlayWindows()

    expect(overlay.isZoneOverlaySender(id)).toBeNull()
    expect(overlay.zoneOverlayDisplayIds()).toEqual([])
    for (const win of FakeBrowserWindow.instances) expect(win.destroyed).toBe(true)
  })

  it('ends the whole session when one overlay is closed from the outside', () => {
    overlay.openZoneOverlayWindows('p1')
    FakeBrowserWindow.instances[0]!.close()

    expect(FakeBrowserWindow.instances[1]!.destroyed).toBe(true)
    expect(overlay.zoneOverlayDisplayIds()).toEqual([])
  })

  it('closes the session on Esc even if the renderer never booted', () => {
    overlay.openZoneOverlayWindows('p1')
    FakeBrowserWindow.instances[1]!.inputHandlers[0]!({}, { type: 'keyDown', key: 'Escape' })

    expect(overlay.zoneOverlayDisplayIds()).toEqual([])
    for (const win of FakeBrowserWindow.instances) expect(win.destroyed).toBe(true)
  })

  it('prunes destroyed windows that never fired closed', () => {
    overlay.openZoneOverlayWindows('p1')
    for (const win of FakeBrowserWindow.instances) win.destroyed = true

    expect(overlay.listZoneOverlayWindows()).toEqual([])
    expect(() => overlay.closeZoneOverlayWindows()).not.toThrow()
  })

  it('opens a fresh session after the previous one closed', () => {
    overlay.openZoneOverlayWindows('p1')
    overlay.closeZoneOverlayWindows()
    overlay.openZoneOverlayWindows('p2')

    expect(FakeBrowserWindow.instances).toHaveLength(4)
    expect(overlay.listZoneOverlayWindows().map((entry) => entry.profileId)).toEqual(['p2', 'p2'])
  })

  it('keeps only the chosen display and flips it out of picker mode', () => {
    overlay.openZoneOverlayWindows('p1')
    const [first, second] = FakeBrowserWindow.instances
    expect(overlay.selectZoneOverlayDisplay(11)).toBe(true)

    expect(second!.destroyed).toBe(true)
    expect(overlay.zoneOverlayDisplayIds()).toEqual([11])
    expect(overlay.isZoneOverlaySender(first!.webContents.id)).toEqual({
      profileId: 'p1',
      displayId: 11,
      pick: false
    })
    expect(loadRoute).toHaveBeenCalledWith(first, '/zones/11?profile=p1')
    // A second pick on the same overlay is a no-op that keeps the editor.
    expect(overlay.selectZoneOverlayDisplay(11)).toBe(true)
    expect(overlay.zoneOverlayDisplayIds()).toEqual([11])
  })
})

// The sandbox/secureWindow posture of this window is pinned centrally by
// base.securityContract.test.ts, which derives its file list from the directory.
