import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The seam between the CLI window registry and the placement layer: opening an
 * agent window with a `placement` asks for bounds, re-tiles the windows that
 * are already there, and never touches one the user has dragged.
 *
 * Kept apart from cliWindow.test.ts because it needs a `screen` and a panel —
 * the plain registry tests deliberately run without either.
 */
const listeners = new Map<FakeBrowserWindow, Map<string, () => void>>()
let nextWebContentsId = 1

interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

class FakeBrowserWindow {
  static instances: FakeBrowserWindow[] = []
  readonly webContents = { id: nextWebContentsId++ }
  destroyed = false
  bounds: Bounds

  constructor(public readonly options: Record<string, unknown>) {
    FakeBrowserWindow.instances.push(this)
    listeners.set(this, new Map())
    this.bounds = {
      x: (options.x as number) ?? 0,
      y: (options.y as number) ?? 0,
      width: (options.width as number) ?? 0,
      height: (options.height as number) ?? 0
    }
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
    return false
  }
  getBounds(): Bounds {
    return this.bounds
  }
  setBounds(bounds: Bounds): void {
    this.bounds = bounds
  }
  show(): void {}
  showInactive(): void {}
  isFocused(): boolean {
    return false
  }
  focus(): void {}
  restore(): void {}
  close(): void {
    this.destroyed = true
    this.emit('closed')
  }
}

const DISPLAYS = [
  { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
  { id: 2, workArea: { x: 1920, y: 0, width: 1600, height: 900 } }
]

vi.mock('electron', () => ({
  BrowserWindow: FakeBrowserWindow,
  screen: {
    getAllDisplays: () => DISPLAYS,
    getPrimaryDisplay: () => DISPLAYS[0]
  }
}))
vi.mock('./base', () => ({
  glassWindowOptions: () => ({ frame: false, transparent: true }),
  loadRoute: vi.fn(),
  secureWindow: vi.fn()
}))

let panelBounds: Bounds | null = null
vi.mock('./panel', () => ({
  getPanelWindow: () => (panelBounds ? { getBounds: () => panelBounds } : null)
}))

type CliModule = typeof import('./cliWindow')
type PlacementModule = typeof import('./placement')
let cli: CliModule
let placement: PlacementModule
let now = 100_000

const WORKER = { title: 'Arlecchino', roleColor: '#2f7d6d' }

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  FakeBrowserWindow.instances = []
  listeners.clear()
  panelBounds = null
  cli = await import('./cliWindow')
  placement = await import('./placement')
  now = 100_000
  placement.resetPlacementStateForTesting(() => now)
})

/** Simulate a real drag: a move event long after any programmatic setBounds. */
function userDrags(win: FakeBrowserWindow): void {
  now += 60_000
  win.emit('move')
}

function fake(win: unknown): FakeBrowserWindow {
  return win as unknown as FakeBrowserWindow
}

describe('createCliWindow with a placement', () => {
  it('re-applies placement bounds after show — compositors often ignore constructor x/y', () => {
    const zones = {
      zones: [{ roleId: 'worker', displayId: 2, rect: { x: 0.5, y: 0, w: 0.5, h: 1 } }]
    }
    const win = fake(
      cli.createCliWindow('a', { ...WORKER, placement: { roleId: 'worker', zones } })
    )
    win.bounds = { x: 0, y: 0, width: 100, height: 100 }

    win.emit('ready-to-show')

    expect(win.bounds).toEqual({ x: 2720, y: 0, width: 800, height: 900 })
  })

  it('opens on the primary display instead of Electron’s default spot', () => {
    const win = fake(
      cli.createCliWindow('a', { ...WORKER, placement: { roleId: 'worker' } })
    )

    expect(win.options.x).toBe(0)
    expect(win.options.y).toBe(0)
    expect(win.options.width).toBeGreaterThan(0)
    expect((win.options.x as number) + (win.options.width as number)).toBeLessThanOrEqual(1920)
  })

  it('puts a role with a zone into that zone', () => {
    const zones = {
      zones: [{ roleId: 'worker', displayId: 2, rect: { x: 0.5, y: 0, w: 0.5, h: 1 } }]
    }
    const win = fake(
      cli.createCliWindow('a', { ...WORKER, placement: { roleId: 'worker', zones } })
    )

    expect(win.options.x).toBe(1920 + 800)
    expect(win.options.width).toBe(800)
    expect(win.options.height).toBe(900)
  })

  it('re-tiles the windows already open when the next agent starts', () => {
    const first = fake(cli.createCliWindow('a', { ...WORKER, placement: { roleId: 'worker' } }))
    const before = { ...first.bounds }

    cli.createCliWindow('b', { ...WORKER, placement: { roleId: 'worker' } })

    expect(first.bounds).not.toEqual(before)
    expect(first.bounds.width).toBeLessThan(before.width)
  })

  it('leaves a window the user dragged exactly where it is', () => {
    const first = fake(cli.createCliWindow('a', { ...WORKER, placement: { roleId: 'worker' } }))
    userDrags(first)
    const pinned = { ...first.bounds }

    cli.createCliWindow('b', { ...WORKER, placement: { roleId: 'worker' } })

    expect(first.bounds).toEqual(pinned)
  })

  it('does not read its own re-tiling as a user drag', () => {
    const first = fake(cli.createCliWindow('a', { ...WORKER, placement: { roleId: 'worker' } }))
    cli.createCliWindow('b', { ...WORKER, placement: { roleId: 'worker' } })
    // The setBounds above emits a move event on Windows.
    first.emit('move')
    const after = { ...first.bounds }

    cli.createCliWindow('c', { ...WORKER, placement: { roleId: 'worker' } })
    expect(first.bounds).not.toEqual(after)
  })

  it('keeps the panel rail clear', () => {
    panelBounds = { x: 1920 - 292, y: 100, width: 280, height: 600 }
    const win = fake(cli.createCliWindow('a', { ...WORKER, placement: { roleId: 'worker' } }))

    expect((win.options.x as number) + (win.options.width as number)).toBeLessThanOrEqual(
      1920 - 280
    )
  })

  it('honours explicit bounds over the placement layer', () => {
    const win = fake(
      cli.createCliWindow('a', {
        ...WORKER,
        bounds: { x: 42, y: 43, width: 500, height: 400 },
        placement: { roleId: 'worker' }
      })
    )

    expect(win.options.x).toBe(42)
    expect(win.options.y).toBe(43)
    expect(win.options.width).toBe(500)
  })

  it('places nothing at all without a placement (the M1 dev path)', () => {
    const win = fake(cli.createCliWindow('a', WORKER))

    expect(win.options.x).toBeUndefined()
    expect(win.options.width).toBe(cli.CLI_DEFAULT_WIDTH)
  })

  it('forgets a closed agent, so the same id tiles again next time', () => {
    const first = fake(cli.createCliWindow('a', { ...WORKER, placement: { roleId: 'worker' } }))
    userDrags(first)
    expect(placement.isMovedByUser('a')).toBe(true)

    cli.closeCliWindow('a')
    expect(placement.isMovedByUser('a')).toBe(false)
  })
})

describe('grow and shrink', () => {
  const ZONES = {
    zones: [{ roleId: 'worker', displayId: 2, rect: { x: 0.5, y: 0, w: 0.5, h: 1 } }]
  }
  const ZONE_BOUNDS = { x: 2720, y: 0, width: 800, height: 900 }

  it('fills the work area of the screen the window sits on', () => {
    const win = fake(
      cli.createCliWindow('a', { ...WORKER, placement: { roleId: 'worker', zones: ZONES } })
    )
    expect(win.bounds).toEqual(ZONE_BOUNDS)

    expect(cli.toggleCliWindowMaximized('a')).toBe(true)
    expect(cli.isCliWindowMaximized('a')).toBe(true)
    // Display 2, because that is where the zone put it — not the primary.
    expect(win.bounds).toEqual(DISPLAYS[1]!.workArea)
  })

  it('shrinks back into the zone, not to where the window happened to be', () => {
    const win = fake(
      cli.createCliWindow('a', { ...WORKER, placement: { roleId: 'worker', zones: ZONES } })
    )
    userDrags(win)
    win.setBounds({ x: 10, y: 10, width: 500, height: 400 })
    cli.toggleCliWindowMaximized('a')

    expect(cli.toggleCliWindowMaximized('a')).toBe(false)
    expect(cli.isCliWindowMaximized('a')).toBe(false)
    expect(win.bounds).toEqual(ZONE_BOUNDS)
    // "Back into its zone" is a decision too — the drag mark is spent.
    expect(placement.isMovedByUser('a')).toBe(false)
  })

  it('falls back to the pre-grow bounds when the window has no placement', () => {
    const win = fake(cli.createCliWindow('a', WORKER))
    win.setBounds({ x: 30, y: 40, width: 700, height: 500 })
    const before = { ...win.bounds }

    cli.toggleCliWindowMaximized('a')
    expect(win.bounds).toEqual(DISPLAYS[0]!.workArea)

    cli.toggleCliWindowMaximized('a')
    expect(win.bounds).toEqual(before)
  })

  it('is never re-tiled out of full screen by the next agent', () => {
    const first = fake(cli.createCliWindow('a', { ...WORKER, placement: { roleId: 'worker' } }))
    cli.toggleCliWindowMaximized('a')
    const full = { ...first.bounds }

    cli.createCliWindow('b', { ...WORKER, placement: { roleId: 'worker' } })

    expect(first.bounds).toEqual(full)
    expect(cli.isCliWindowMaximized('a')).toBe(true)
  })

  it('is a no-op for an agent that has no window', () => {
    expect(cli.toggleCliWindowMaximized('ghost')).toBe(false)
    expect(cli.isCliWindowMaximized('ghost')).toBe(false)
  })

  it('forgets the state when the window closes', () => {
    cli.createCliWindow('a', { ...WORKER, placement: { roleId: 'worker' } })
    cli.toggleCliWindowMaximized('a')
    cli.closeCliWindow('a')

    expect(cli.isCliWindowMaximized('a')).toBe(false)
  })
})

describe('workspace-isolated tiling', () => {
  it('does not move a window that belongs to another workspace', () => {
    const first = fake(
      cli.createCliWindow('a', { ...WORKER, placement: { roleId: 'worker', workspaceId: 'A' } })
    )
    const pinned = { ...first.bounds }

    cli.createCliWindow('b', { ...WORKER, placement: { roleId: 'worker', workspaceId: 'B' } })

    expect(first.bounds).toEqual(pinned)
  })

  it('still re-tiles two windows of the same workspace', () => {
    const first = fake(
      cli.createCliWindow('a', { ...WORKER, placement: { roleId: 'worker', workspaceId: 'W' } })
    )
    const before = { ...first.bounds }

    cli.createCliWindow('b', { ...WORKER, placement: { roleId: 'worker', workspaceId: 'W' } })

    expect(first.bounds).not.toEqual(before)
    expect(first.bounds.width).toBeLessThan(before.width)
  })

  it('groups windows that omit workspaceId with each other, not with a named workspace', () => {
    const first = fake(cli.createCliWindow('a', { ...WORKER, placement: { roleId: 'worker' } }))
    const before = { ...first.bounds }

    cli.createCliWindow('b', { ...WORKER, placement: { roleId: 'worker' } })
    expect(first.bounds).not.toEqual(before)
    const afterPair = { ...first.bounds }

    cli.createCliWindow('c', { ...WORKER, placement: { roleId: 'worker', workspaceId: 'B' } })
    expect(first.bounds).toEqual(afterPair)
  })
})

describe('layoutCliWindows', () => {
  const ZONES = {
    zones: [{ roleId: 'worker', displayId: 2, rect: { x: 0.5, y: 0, w: 0.5, h: 1 } }]
  }
  const ZONE_BOUNDS = { x: 2720, y: 0, width: 800, height: 900 }

  it('snaps workspace windows into zones even if they were marked movedByUser', () => {
    const win = fake(
      cli.createCliWindow('a', {
        ...WORKER,
        placement: { roleId: 'worker', zones: ZONES, workspaceId: 'W' }
      })
    )
    userDrags(win)
    win.setBounds({ x: 10, y: 10, width: 500, height: 400 })
    expect(placement.isMovedByUser('a')).toBe(true)

    cli.layoutCliWindows(['a'])

    expect(win.bounds).toEqual(ZONE_BOUNDS)
    expect(placement.isMovedByUser('a')).toBe(false)
  })

  it('leaves a maximized window put', () => {
    const first = fake(
      cli.createCliWindow('a', {
        ...WORKER,
        placement: { roleId: 'worker', zones: ZONES, workspaceId: 'W' }
      })
    )
    const second = fake(
      cli.createCliWindow('b', {
        ...WORKER,
        placement: { roleId: 'worker', zones: ZONES, workspaceId: 'W' }
      })
    )
    cli.toggleCliWindowMaximized('a')
    const full = { ...first.bounds }

    cli.layoutCliWindows(['a', 'b'])

    expect(first.bounds).toEqual(full)
    expect(cli.isCliWindowMaximized('a')).toBe(true)
    // Opted out of the tile count, so the sibling takes the whole zone.
    expect(second.bounds).toEqual(ZONE_BOUNDS)
  })

  it('snaps only the first placement\'s workspace and leaves the other put', () => {
    const zonesA = {
      zones: [{ roleId: 'worker', displayId: 1, rect: { x: 0, y: 0, w: 0.5, h: 1 } }]
    }
    const zonesB = {
      zones: [{ roleId: 'worker', displayId: 2, rect: { x: 0.5, y: 0, w: 0.5, h: 1 } }]
    }
    const zoneA = { x: 0, y: 0, width: 960, height: 1040 }

    const a1 = fake(
      cli.createCliWindow('a1', {
        ...WORKER,
        placement: { roleId: 'worker', zones: zonesA, workspaceId: 'A' }
      })
    )
    const a2 = fake(
      cli.createCliWindow('a2', {
        ...WORKER,
        placement: { roleId: 'worker', zones: zonesA, workspaceId: 'A' }
      })
    )
    const b1 = fake(
      cli.createCliWindow('b1', {
        ...WORKER,
        placement: { roleId: 'worker', zones: zonesB, workspaceId: 'B' }
      })
    )

    userDrags(a1)
    a1.setBounds({ x: 10, y: 10, width: 500, height: 400 })
    userDrags(a2)
    a2.setBounds({ x: 20, y: 20, width: 500, height: 400 })
    userDrags(b1)
    b1.setBounds({ x: 30, y: 30, width: 500, height: 400 })
    const pinnedB = { ...b1.bounds }

    cli.layoutCliWindows(['a1', 'a2', 'b1'])

    expect(b1.bounds).toEqual(pinnedB)
    expect(placement.isMovedByUser('b1')).toBe(true)
    expect(a1.bounds).not.toEqual({ x: 10, y: 10, width: 500, height: 400 })
    expect(a2.bounds).not.toEqual({ x: 20, y: 20, width: 500, height: 400 })
    expect(a1.bounds.x).toBeGreaterThanOrEqual(zoneA.x)
    expect(a1.bounds.x + a1.bounds.width).toBeLessThanOrEqual(zoneA.x + zoneA.width)
    expect(a2.bounds.x).toBeGreaterThanOrEqual(zoneA.x)
    expect(a2.bounds.x + a2.bounds.width).toBeLessThanOrEqual(zoneA.x + zoneA.width)
  })
})
