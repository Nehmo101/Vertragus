import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The tracker's production wiring imports `screen`; the state machine under
// test never touches it.
vi.mock('electron', () => ({ screen: { getCursorScreenPoint: vi.fn() } }))

import {
  createPanelHoverTracker,
  isPointerInside,
  PANEL_HOVER_POLL_MS,
  PANEL_HOVER_TOLERANCE,
  PANEL_POINTER_CHANNEL,
  type PanelHoverBounds,
  type PanelHoverTracker,
  type PanelPointerEvent
} from './panelHover'

const BOUNDS: PanelHoverBounds = { x: 1000, y: 40, width: 280, height: 680 }

/** A fake interval table: the test decides when a tick happens. */
class FakeTimers {
  private next = 1
  readonly running = new Map<number, { handler: () => void; ms: number; unrefs: number }>()

  setInterval = (handler: () => void, ms: number): unknown => {
    const id = this.next++
    const entry = { handler, ms, unrefs: 0 }
    this.running.set(id, entry)
    return { id, unref: () => (entry.unrefs += 1) }
  }
  clearInterval = (handle: unknown): void => {
    this.running.delete((handle as { id: number }).id)
  }
  /** Fire every live interval once. */
  advance(times = 1): void {
    for (let i = 0; i < times; i += 1) {
      for (const entry of [...this.running.values()]) entry.handler()
    }
  }
  only(): { ms: number; unrefs: number } {
    const entries = [...this.running.values()]
    expect(entries).toHaveLength(1)
    return entries[0]!
  }
}

interface Harness {
  timers: FakeTimers
  tracker: PanelHoverTracker
  sent: PanelPointerEvent[]
  cursor: { x: number; y: number }
  window: { destroyed: boolean; visible: boolean; bounds: PanelHoverBounds; boundsThrows: boolean }
}

function harness(): Harness {
  const timers = new FakeTimers()
  const sent: PanelPointerEvent[] = []
  const cursor = { x: 0, y: 0 }
  const window = { destroyed: false, visible: true, bounds: BOUNDS, boundsThrows: false }
  const tracker = createPanelHoverTracker({
    window: {
      isDestroyed: () => window.destroyed,
      isVisible: () => window.visible,
      getBounds: () => {
        if (window.boundsThrows) throw new Error('window is gone')
        return window.bounds
      },
      send: (channel, payload) => {
        expect(channel).toBe(PANEL_POINTER_CHANNEL)
        sent.push(payload)
      }
    },
    cursorPoint: () => ({ ...cursor }),
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval
  })
  return { timers, tracker, sent, cursor, window }
}

let h: Harness

beforeEach(() => {
  h = harness()
})

describe('isPointerInside', () => {
  it('accepts the interior and rejects the outside', () => {
    expect(isPointerInside({ x: 1100, y: 300 }, BOUNDS)).toBe(true)
    expect(isPointerInside({ x: 900, y: 300 }, BOUNDS)).toBe(false)
    expect(isPointerInside({ x: 1100, y: 900 }, BOUNDS)).toBe(false)
  })

  it('treats the border and a few pixels beyond it as inside', () => {
    // A panel docked to a screen edge must not flicker at its own border.
    expect(isPointerInside({ x: 1000, y: 40 }, BOUNDS)).toBe(true)
    expect(isPointerInside({ x: 1280, y: 720 }, BOUNDS)).toBe(true)
    expect(isPointerInside({ x: 1280 + PANEL_HOVER_TOLERANCE, y: 300 }, BOUNDS)).toBe(true)
    expect(isPointerInside({ x: 1280 + PANEL_HOVER_TOLERANCE + 1, y: 300 }, BOUNDS)).toBe(false)
  })

  it('honours an explicit tolerance of zero', () => {
    expect(isPointerInside({ x: 1284, y: 300 }, BOUNDS, 0)).toBe(false)
    expect(isPointerInside({ x: 1280, y: 300 }, BOUNDS, 0)).toBe(true)
  })
})

describe('the hover tracker', () => {
  it('polls on an unref-ed interval and pushes the initial state at once', () => {
    h.cursor.x = 1100
    h.cursor.y = 300
    h.tracker.start()

    expect(h.timers.only().ms).toBe(PANEL_HOVER_POLL_MS)
    expect(h.timers.only().unrefs).toBe(1)
    expect(h.sent).toEqual([{ inside: true }])
  })

  it('sends only on a state change, not on every tick', () => {
    h.cursor.x = 100
    h.tracker.start()
    h.timers.advance(3)
    expect(h.sent).toEqual([{ inside: false }])

    h.cursor.x = 1100
    h.cursor.y = 300
    h.timers.advance()
    h.timers.advance()
    expect(h.sent).toEqual([{ inside: false }, { inside: true }])

    h.cursor.x = 100
    h.timers.advance()
    expect(h.sent).toEqual([{ inside: false }, { inside: true }, { inside: false }])
  })

  it('reports "outside" while the panel is hidden, without reading the cursor', () => {
    h.cursor.x = 1100
    h.cursor.y = 300
    h.tracker.start()
    expect(h.sent).toEqual([{ inside: true }])

    h.window.visible = false
    h.timers.advance()
    expect(h.sent.at(-1)).toEqual({ inside: false })
  })

  it('start is idempotent and stop ends the polling', () => {
    h.tracker.start()
    h.tracker.start()
    expect(h.timers.running.size).toBe(1)
    expect(h.tracker.isRunning()).toBe(true)

    h.tracker.stop()
    h.tracker.stop()
    expect(h.timers.running.size).toBe(0)
    expect(h.tracker.isRunning()).toBe(false)
    expect(h.tracker.lastInside()).toBeUndefined()
  })

  it('re-pushes the truth after a hide/show cycle', () => {
    h.cursor.x = 1100
    h.cursor.y = 300
    h.tracker.start()
    h.tracker.stop()
    h.tracker.start()

    // Both starts push, because stop forgets — the renderer that was hidden in
    // between must not be left with a stale class.
    expect(h.sent).toEqual([{ inside: true }, { inside: true }])
  })

  it('resync re-pushes for a reloaded renderer, and does nothing while stopped', () => {
    h.cursor.x = 1100
    h.cursor.y = 300
    h.tracker.start()
    h.tracker.resync()
    expect(h.sent).toEqual([{ inside: true }, { inside: true }])

    h.tracker.stop()
    h.tracker.resync()
    expect(h.sent).toHaveLength(2)
  })

  it('never starts or keeps polling for a destroyed window', () => {
    h.tracker.start()
    h.window.destroyed = true
    h.timers.advance()
    expect(h.tracker.isRunning()).toBe(false)

    h.tracker.start()
    expect(h.tracker.isRunning()).toBe(false)
    expect(h.sent).toEqual([{ inside: false }])
  })

  it('stops instead of throwing out of the timer when bounds are gone', () => {
    h.tracker.start()
    h.window.boundsThrows = true
    expect(() => h.timers.advance()).not.toThrow()
    expect(h.tracker.isRunning()).toBe(false)
  })

  it('follows the panel when it is dragged to another position', () => {
    h.cursor.x = 1100
    h.cursor.y = 300
    h.tracker.start()
    expect(h.sent).toEqual([{ inside: true }])

    h.window.bounds = { x: 12, y: 40, width: 280, height: 680 }
    h.timers.advance()
    expect(h.sent.at(-1)).toEqual({ inside: false })
  })
})

describe('preload parity', () => {
  it('uses the channel name preload listens on', () => {
    const source = readFileSync(join(__dirname, '../../preload/index.ts'), 'utf8')
    expect(source).toContain(`'${PANEL_POINTER_CHANNEL}'`)
  })
})
