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
