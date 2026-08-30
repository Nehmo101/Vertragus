import { beforeEach, describe, expect, it } from 'vitest'
import { zoneLayoutSchema, type ZoneLayout } from '@shared/schema/zones'
import { ORCHESTRATOR_ROLE_ID } from '@shared/prompts/roles'
import {
  applyWindowBounds,
  displaysForPlacement,
  forgetWindowPlacement,
  flushLiveReflow,
  isMovedByUser,
  mergeLiveReflowZones,
  placeAgentWindow,
  planLiveReflow,
  planWindowLayout,
  PROGRAMMATIC_GRACE_MS,
  REFLOW_DEBOUNCE_MS,
  resetPlacementStateForTesting,
  setLiveReflowHandler,
  setReflowNeighborsGetter,
  SNAP_GRACE_MS,
  suppressMoveTracking,
  trackWindowMoves,
  type DisplayInfo,
  type MovableWindow,
  type Rect
} from './placement'

/**
 * Placement is pure geometry, so every case below runs on fake monitors: no
 * Electron, no windows, no screen. The only stateful part — "the user moved
 * this one, hands off" — is exercised through a fake window at the bottom.
 */

const PRIMARY: DisplayInfo = {
  id: 1,
  primary: true,
  workArea: { x: 0, y: 0, width: 1920, height: 1080 }
}
const SECOND: DisplayInfo = {
  id: 2,
  workArea: { x: 1920, y: 0, width: 1600, height: 900 }
}
/** A small primary next to a big secondary — the "Display 1 wins" case. */
const SMALL_PRIMARY: DisplayInfo = {
  id: 1,
  primary: true,
  workArea: { x: 0, y: 0, width: 1280, height: 800 }
}
const BIG_SECOND: DisplayInfo = {
  id: 2,
  workArea: { x: 1280, y: 0, width: 3840, height: 2160 }
}

function layout(...zones: { roleId: string; displayId: number; rect: Rect0 }[]): ZoneLayout {
  return zoneLayoutSchema.parse({ zones })
}
interface Rect0 {
  x: number
  y: number
  w: number
  h: number
}

function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  )
}

function overlaps(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
  )
}

function areaOf(rect: Rect): number {
  return rect.width * rect.height
}

describe('placeAgentWindow — zones', () => {
  it('puts a role with a zone into that zone on that display', () => {
    const profile = {
      zones: layout({ roleId: 'worker', displayId: 2, rect: { x: 0.5, y: 0, w: 0.5, h: 1 } })
    }
    const bounds = placeAgentWindow({
      profile,
      roleId: 'worker',
      displays: [PRIMARY, SECOND]
    })

    expect(bounds).toEqual({ x: 1920 + 800, y: 0, width: 800, height: 900 })
    expect(contains(SECOND.workArea, bounds)).toBe(true)
  })

  it('splits the zone into a mini grid when several agents share the role', () => {
    const profile = {
      zones: layout({ roleId: 'worker', displayId: 1, rect: { x: 0.5, y: 0, w: 0.5, h: 1 } })
    }
    const zone: Rect = { x: 960, y: 0, width: 960, height: 1080 }
    const plan = planWindowLayout({
      profile,
      displays: [PRIMARY],
      windows: [
        { agentId: 'a', roleId: 'worker' },
        { agentId: 'b', roleId: 'worker' },
        { agentId: 'c', roleId: 'worker' }
      ]
    })

    expect(plan).toHaveLength(3)
    for (const entry of plan) expect(contains(zone, entry.bounds)).toBe(true)
    expect(overlaps(plan[0]!.bounds, plan[1]!.bounds)).toBe(false)
    expect(overlaps(plan[1]!.bounds, plan[2]!.bounds)).toBe(false)
  })

  it('spreads a role with one zone per monitor round-robin over both', () => {
    const profile = {
      zones: layout(
        { roleId: 'worker', displayId: 1, rect: { x: 0, y: 0, w: 0.5, h: 1 } },
        { roleId: 'worker', displayId: 2, rect: { x: 0, y: 0, w: 0.5, h: 1 } }
      )
    }
    const plan = planWindowLayout({
      profile,
      displays: [PRIMARY, SECOND],
      windows: [
        { agentId: 'a', roleId: 'worker' },
        { agentId: 'b', roleId: 'worker' }
      ]
    })

    expect(contains(PRIMARY.workArea, plan[0]!.bounds)).toBe(true)
    expect(contains(SECOND.workArea, plan[1]!.bounds)).toBe(true)
  })

  it('applies a zone with a stale display id when only one monitor remains', () => {
    // Sole remaining display: rematch rather than pretend the zone is gone.
    const profile = {
      zones: layout({ roleId: 'worker', displayId: 99, rect: { x: 0.5, y: 0, w: 0.5, h: 1 } })
    }
    const bounds = placeAgentWindow({ profile, roleId: 'worker', displays: [PRIMARY] })

    expect(bounds).toEqual({ x: 960, y: 0, width: 960, height: 1080 })
  })

  it('falls back to auto-tiling when no attached display can own the zone', () => {
    const profile = {
      zones: layout({ roleId: 'worker', displayId: 99, rect: { x: 0.5, y: 0, w: 0.5, h: 1 } })
    }
    // Two monitors, neither matching — do not guess which one inherits the zone.
    const bounds = placeAgentWindow({
      profile,
      roleId: 'worker',
      displays: [PRIMARY, SECOND]
    })

    expect(contains(PRIMARY.workArea, bounds)).toBe(true)
    expect(bounds).not.toEqual({ x: 960, y: 0, width: 960, height: 1080 })
  })

  it('leaves a role without a zone to the auto-tiling even when others have one', () => {
    const profile = {
      zones: layout({ roleId: 'worker', displayId: 1, rect: { x: 0.6, y: 0, w: 0.4, h: 1 } })
    }
    const plan = planWindowLayout({
      profile,
      displays: [PRIMARY],
      windows: [
        { agentId: 'w', roleId: 'worker' },
        { agentId: 'r', roleId: 'reviewer' }
      ]
    })
    const worker = plan.find((entry) => entry.agentId === 'w')!.bounds
    const reviewer = plan.find((entry) => entry.agentId === 'r')!.bounds

    expect(worker).toEqual({ x: 1152, y: 0, width: 768, height: 1080 })
    // The reviewer is auto-tiled; it does not know about the worker's zone.
    expect(contains(PRIMARY.workArea, reviewer)).toBe(true)
  })
})

describe('placeAgentWindow — auto-tiling', () => {
  it('gives the orchestrator the largest cell on the primary display', () => {
    const plan = planWindowLayout({
      displays: [PRIMARY],
      windows: [
        { agentId: 'w1', roleId: 'worker' },
        { agentId: 'orch', roleId: ORCHESTRATOR_ROLE_ID },
        { agentId: 'w2', roleId: 'worker' }
      ]
    })
    const orchestrator = plan.find((entry) => entry.agentId === 'orch')!.bounds
    const workers = plan.filter((entry) => entry.agentId !== 'orch').map((entry) => entry.bounds)

    expect(contains(PRIMARY.workArea, orchestrator)).toBe(true)
    for (const worker of workers) {
      expect(areaOf(orchestrator)).toBeGreaterThanOrEqual(areaOf(worker))
      expect(overlaps(orchestrator, worker)).toBe(false)
    }
  })

  it('keeps the orchestrator on display 1 even when a bigger monitor exists', () => {
    const bounds = placeAgentWindow({
      roleId: ORCHESTRATOR_ROLE_ID,
      displays: [BIG_SECOND, SMALL_PRIMARY]
    })
    expect(contains(SMALL_PRIMARY.workArea, bounds)).toBe(true)
  })

  it('spills onto the next display once the first one is comfortably full', () => {
    const plan = planWindowLayout({
      displays: [SMALL_PRIMARY, BIG_SECOND],
      windows: [
        { agentId: 'orch', roleId: ORCHESTRATOR_ROLE_ID },
        { agentId: 'a', roleId: 'worker' },
        { agentId: 'b', roleId: 'worker' },
        { agentId: 'c', roleId: 'worker' }
      ]
    })
    const on = (id: string): Rect => plan.find((entry) => entry.agentId === id)!.bounds

    // 1280x800 holds exactly one comfortable tile — the orchestrator's.
    expect(contains(SMALL_PRIMARY.workArea, on('orch'))).toBe(true)
    for (const id of ['a', 'b', 'c']) {
      expect(contains(BIG_SECOND.workArea, on(id))).toBe(true)
    }
  })

  it('keeps the panel rail clear on the display it is docked to', () => {
    const plan = planWindowLayout({
      displays: [PRIMARY],
      rail: { displayId: PRIMARY.id, edge: 'right', width: 292 },
      windows: [
        { agentId: 'a', roleId: 'worker' },
        { agentId: 'b', roleId: 'worker' }
      ]
    })
    for (const entry of plan) {
      expect(entry.bounds.x + entry.bounds.width).toBeLessThanOrEqual(1920 - 292)
    }
  })

  it('places the first window of all on the primary display', () => {
    const bounds = placeAgentWindow({ roleId: 'worker', displays: [PRIMARY, SECOND] })
    expect(contains(PRIMARY.workArea, bounds)).toBe(true)
  })

  it('pins every window to the profile’s chosen screen', () => {
    const profile = {
      zones: zoneLayoutSchema.parse({ targetDisplayId: SECOND.id, zones: [] })
    }
    const plan = planWindowLayout({
      profile,
      displays: [PRIMARY, SECOND],
      windows: [
        { agentId: 'orch', roleId: ORCHESTRATOR_ROLE_ID },
        { agentId: 'a', roleId: 'worker' },
        { agentId: 'b', roleId: 'worker' }
      ]
    })
    for (const entry of plan) {
      expect(contains(SECOND.workArea, entry.bounds)).toBe(true)
    }
  })

  it('ignores leftover zones on a screen that is not the target', () => {
    const profile = {
      zones: zoneLayoutSchema.parse({
        targetDisplayId: SECOND.id,
        zones: [{ roleId: 'worker', displayId: PRIMARY.id, rect: { x: 0.5, y: 0, w: 0.5, h: 1 } }]
      })
    }
    const bounds = placeAgentWindow({
      profile,
      roleId: 'worker',
      displays: [PRIMARY, SECOND]
    })
    expect(contains(SECOND.workArea, bounds)).toBe(true)
    expect(bounds).not.toEqual({ x: 960, y: 0, width: 960, height: 1080 })
  })

  it('places on the saved screen after Display.id churn', () => {
    const profile = {
      zones: zoneLayoutSchema.parse({
        targetDisplayId: 99,
        targetWorkArea: SECOND.workArea,
        zones: [{ roleId: 'worker', displayId: 99, rect: { x: 0.5, y: 0, w: 0.5, h: 1 } }]
      })
    }
    const bounds = placeAgentWindow({
      profile,
      roleId: 'worker',
      displays: [PRIMARY, SECOND]
    })
    expect(contains(SECOND.workArea, bounds)).toBe(true)
  })

  it('ignores leftover primary zones after Display.id rematch', () => {
    const profile = {
      zones: zoneLayoutSchema.parse({
        targetDisplayId: 99,
        targetWorkArea: SECOND.workArea,
        zones: [
          { roleId: 'worker', displayId: PRIMARY.id, rect: { x: 0.5, y: 0, w: 0.5, h: 1 } },
          { roleId: 'worker', displayId: SECOND.id, rect: { x: 0, y: 0, w: 0.25, h: 1 } }
        ]
      })
    }
    const bounds = placeAgentWindow({
      profile,
      roleId: 'worker',
      displays: [PRIMARY, SECOND]
    })
    expect(bounds).toEqual({ x: 1920, y: 0, width: 400, height: 900 })
    expect(bounds).not.toEqual({ x: 960, y: 0, width: 960, height: 1080 })
  })

  it('returns a usable rect when there is no display at all', () => {
    const bounds = placeAgentWindow({ roleId: 'worker', displays: [] })
    expect(bounds.width).toBeGreaterThan(0)
    expect(bounds.height).toBeGreaterThan(0)
  })
})

describe('displaysForPlacement', () => {
  it('narrows to the target when it is attached and otherwise leaves the list', () => {
    expect(displaysForPlacement([PRIMARY, SECOND], SECOND.id)).toEqual([SECOND])
    expect(displaysForPlacement([PRIMARY, SECOND], 99)).toEqual([PRIMARY, SECOND])
    expect(displaysForPlacement([PRIMARY], 99)).toEqual([PRIMARY])
    expect(displaysForPlacement([PRIMARY, SECOND], undefined)).toEqual([PRIMARY, SECOND])
  })

  it('rematches a stale target id from the saved work area', () => {
    expect(displaysForPlacement([PRIMARY, SECOND], 99, SECOND.workArea)).toEqual([SECOND])
    expect(displaysForPlacement([PRIMARY, SECOND], 99, { x: 50, y: 50, width: 10, height: 10 })).toEqual(
      [PRIMARY, SECOND]
    )
    expect(displaysForPlacement([], 2, SECOND.workArea)).toEqual([])
  })
})

describe('windows the user moved', () => {
  beforeEach(() => resetPlacementStateForTesting())

  it('drops moved windows out of the layout entirely', () => {
    const plan = planWindowLayout({
      displays: [PRIMARY],
      windows: [
        { agentId: 'pinned', roleId: 'worker', movedByUser: true },
        { agentId: 'fresh', roleId: 'worker' }
      ]
    })

    expect(plan.map((entry) => entry.agentId)).toEqual(['fresh'])
  })

  it('re-tiles only the untouched windows when a new agent starts', () => {
    const before = planWindowLayout({
      displays: [PRIMARY],
      windows: [{ agentId: 'a', roleId: 'worker' }]
    })
    const after = planWindowLayout({
      displays: [PRIMARY],
      windows: [
        { agentId: 'a', roleId: 'worker' },
        { agentId: 'pinned', roleId: 'worker', movedByUser: true },
        { agentId: 'b', roleId: 'worker' }
      ]
    })

    expect(after.map((entry) => entry.agentId)).toEqual(['a', 'b'])
    // The first window does get re-tiled — it was never moved by hand.
    expect(after[0]!.bounds).not.toEqual(before[0]!.bounds)
  })

  it('marks a window moved only for gestures outside the programmatic grace', () => {
    let clock = 1_000
    const events = new Map<string, () => void>()
    const win: MovableWindow & { bounds?: Rect } = {
      on: (event, handler) => events.set(event, handler),
      setBounds(bounds) {
        this.bounds = bounds
      },
      isDestroyed: () => false
    }

    trackWindowMoves('a', win, () => clock)
    // Our own placement, echoed back as a move event: not the user.
    applyWindowBounds('a', win, { x: 10, y: 10, width: 800, height: 600 }, () => clock)
    clock += PROGRAMMATIC_GRACE_MS - 1
    events.get('move')!()
    expect(isMovedByUser('a')).toBe(false)
    expect(win.bounds).toEqual({ x: 10, y: 10, width: 800, height: 600 })

    // Long after: a real drag.
    clock += 5_000
    events.get('move')!()
    expect(isMovedByUser('a')).toBe(true)
  })

  it('treats a user resize like a user move', () => {
    let clock = 1_000
    const events = new Map<string, () => void>()
    const win: MovableWindow = {
      on: (event, handler) => events.set(event, handler),
      setBounds: () => undefined
    }

    trackWindowMoves('b', win, () => clock)
    clock += 5_000
    events.get('resize')!()
    expect(isMovedByUser('b')).toBe(true)
  })

  it('forgets the mark when the window closes, so a restart tiles again', () => {
    let clock = 1_000
    const events = new Map<string, () => void>()
    const win: MovableWindow = {
      on: (event, handler) => events.set(event, handler),
      setBounds: () => undefined
    }

    trackWindowMoves('c', win, () => clock)
    clock += 5_000
    events.get('move')!()
    expect(isMovedByUser('c')).toBe(true)

    forgetWindowPlacement('c')
    expect(isMovedByUser('c')).toBe(false)
  })

  it('never touches a destroyed window', () => {
    let called = 0
    const win: MovableWindow = {
      on: () => undefined,
      setBounds: () => {
        called += 1
      },
      isDestroyed: () => true
    }
    applyWindowBounds('gone', win, { x: 0, y: 0, width: 100, height: 100 })
    expect(called).toBe(0)
  })

  it('jumps to the target origin before setBounds so a cross-display move sticks', () => {
    let bounds: Rect = { x: 10, y: 10, width: 400, height: 300 }
    let originPinned = false
    const win: MovableWindow = {
      on: () => undefined,
      getBounds: () => bounds,
      setPosition(x, y) {
        bounds = { ...bounds, x, y }
        originPinned = true
      },
      setBounds(next) {
        // Windows: a lone setBounds onto another display is ignored.
        if (!originPinned && next.x !== bounds.x) return
        bounds = next
        originPinned = false
      }
    }
    applyWindowBounds('a', win, { x: 2000, y: 10, width: 700, height: 500 })
    expect(win.getBounds?.()).toEqual({ x: 2000, y: 10, width: 700, height: 500 })
  })

  it('retries setPosition+setBounds when the compositor ignores the first jump', () => {
    let bounds: Rect = { x: 10, y: 10, width: 400, height: 300 }
    let setBoundsCalls = 0
    const win: MovableWindow = {
      on: () => undefined,
      getBounds: () => bounds,
      setPosition(x, y) {
        bounds = { ...bounds, x, y }
      },
      setBounds(next) {
        setBoundsCalls += 1
        if (setBoundsCalls === 1) {
          // Hide/show dump: compositor puts the window back on the primary.
          bounds = { x: 10, y: 10, width: 400, height: 300 }
          return
        }
        bounds = next
      }
    }
    applyWindowBounds('a', win, { x: 2000, y: 50, width: 700, height: 500 })
    expect(setBoundsCalls).toBe(2)
    expect(win.getBounds?.()).toEqual({ x: 2000, y: 50, width: 700, height: 500 })
  })

  it('pins by y when x already matches the target origin', () => {
    let bounds: Rect = { x: 2000, y: 0, width: 400, height: 300 }
    let positioned = 0
    const win: MovableWindow = {
      on: () => undefined,
      getBounds: () => bounds,
      setPosition(x, y) {
        positioned += 1
        bounds = { ...bounds, x, y }
      },
      setBounds(next) {
        bounds = next
      }
    }
    applyWindowBounds('a', win, { x: 2000, y: 80, width: 700, height: 500 })
    expect(positioned).toBe(1)
    expect(bounds).toEqual({ x: 2000, y: 80, width: 700, height: 500 })
  })

  it('skips setPosition when the window is already at the target origin', () => {
    let bounds: Rect = { x: 2000, y: 10, width: 400, height: 300 }
    let positioned = 0
    const win: MovableWindow = {
      on: () => undefined,
      getBounds: () => bounds,
      setPosition() {
        positioned += 1
      },
      setBounds(next) {
        bounds = next
      }
    }
    applyWindowBounds('a', win, { x: 2000, y: 10, width: 700, height: 500 })
    expect(positioned).toBe(0)
    expect(bounds).toEqual({ x: 2000, y: 10, width: 700, height: 500 })
  })

  it('still setBounds when the window cannot report its origin', () => {
    let applied: Rect | undefined
    const win: MovableWindow = {
      on: () => undefined,
      setBounds(next) {
        applied = next
      }
    }
    applyWindowBounds('a', win, { x: 2000, y: 10, width: 700, height: 500 })
    expect(applied).toEqual({ x: 2000, y: 10, width: 700, height: 500 })
  })

  it('still setBounds when setPosition is missing', () => {
    let bounds: Rect = { x: 10, y: 10, width: 400, height: 300 }
    const win: MovableWindow = {
      on: () => undefined,
      getBounds: () => bounds,
      setBounds(next) {
        bounds = next
      }
    }
    applyWindowBounds('a', win, { x: 2000, y: 10, width: 700, height: 500 })
    expect(bounds).toEqual({ x: 2000, y: 10, width: 700, height: 500 })
  })

  it('does not shrink an in-flight snap grace with a shorter suppress', () => {
    let clock = 1_000
    const events = new Map<string, () => void>()
    const win: MovableWindow = {
      on: (event, handler) => events.set(event, handler),
      setBounds: () => undefined
    }
    trackWindowMoves('a', win, () => clock)
    suppressMoveTracking('a', () => clock, SNAP_GRACE_MS)
    suppressMoveTracking('a', () => clock, PROGRAMMATIC_GRACE_MS)
    clock += PROGRAMMATIC_GRACE_MS + 1
    events.get('move')!()
    expect(isMovedByUser('a')).toBe(false)
    clock = 1_000 + SNAP_GRACE_MS
    events.get('move')!()
    expect(isMovedByUser('a')).toBe(true)
  })
})

describe('live neighbor reflow', () => {
  beforeEach(() => resetPlacementStateForTesting())

  it('fills the gap when a same-display neighbor is resized', () => {
    const plan = planLiveReflow({
      displays: [PRIMARY],
      previousDisplayId: PRIMARY.id,
      movedId: 'left',
      nextRect: { x: 0, y: 0, width: 600, height: 1080 },
      windows: [
        { agentId: 'left', roleId: 'worker', bounds: { x: 0, y: 0, width: 960, height: 1080 } },
        { agentId: 'right', roleId: 'reviewer', bounds: { x: 960, y: 0, width: 960, height: 1080 } }
      ]
    })

    expect(plan).not.toBeNull()
    expect(plan!.markMoved).toEqual([])
    const right = plan!.placements.find((entry) => entry.agentId === 'right')!.bounds
    expect(right.x).toBe(600)
    expect(right.width).toBe(1320)
    expect(plan!.zones.zones).toHaveLength(2)
  })

  it('keeps the panel rail clear of reflowed neighbors', () => {
    const plan = planLiveReflow({
      displays: [PRIMARY],
      previousDisplayId: PRIMARY.id,
      rail: { displayId: PRIMARY.id, edge: 'right', width: 292 },
      movedId: 'left',
      nextRect: { x: 0, y: 0, width: 600, height: 1080 },
      windows: [
        { agentId: 'left', roleId: 'worker', bounds: { x: 0, y: 0, width: 800, height: 1080 } },
        { agentId: 'right', roleId: 'reviewer', bounds: { x: 800, y: 0, width: 820, height: 1080 } }
      ]
    })

    const right = plan!.placements.find((entry) => entry.agentId === 'right')!.bounds
    expect(right.x + right.width).toBeLessThanOrEqual(1920 - 292)
  })

  it('skips a maximized window and leaves it out of the reflow set', () => {
    const full = PRIMARY.workArea
    const plan = planLiveReflow({
      displays: [PRIMARY],
      previousDisplayId: PRIMARY.id,
      movedId: 'left',
      nextRect: { x: 0, y: 0, width: 600, height: 1080 },
      windows: [
        { agentId: 'left', roleId: 'worker', bounds: { x: 0, y: 0, width: 960, height: 1080 } },
        {
          agentId: 'max',
          roleId: 'reviewer',
          bounds: full,
          maximized: true
        }
      ]
    })

    expect(plan!.placements.map((entry) => entry.agentId)).toEqual(['left'])
    expect(plan!.placements.find((entry) => entry.agentId === 'max')).toBeUndefined()
  })

  it('keeps overlay zones that no live window occupies on the reflowed display', () => {
    const existing = layout(
      { roleId: 'worker', displayId: 1, rect: { x: 0, y: 0, w: 0.5, h: 1 } },
      { roleId: 'reviewer', displayId: 1, rect: { x: 0.5, y: 0, w: 0.5, h: 1 } },
      { roleId: 'orchestrator', displayId: 1, rect: { x: 0, y: 0, w: 0.25, h: 0.25 } },
      { roleId: 'worker', displayId: 2, rect: { x: 0, y: 0, w: 1, h: 1 } }
    )
    const live = layout(
      { roleId: 'worker', displayId: 1, rect: { x: 0, y: 0, w: 600 / 1920, h: 1 } },
      { roleId: 'reviewer', displayId: 1, rect: { x: 600 / 1920, y: 0, w: 1320 / 1920, h: 1 } }
    )
    const merged = mergeLiveReflowZones(existing, live, [PRIMARY.id])

    expect(
      merged.zones.map((zone) => `${zone.roleId}:${zone.displayId}`)
    ).toEqual(['orchestrator:1', 'worker:2', 'worker:1', 'reviewer:1'])
    expect(
      merged.zones.find((zone) => zone.roleId === 'orchestrator' && zone.displayId === 1)?.rect
    ).toEqual({ x: 0, y: 0, w: 0.25, h: 0.25 })
    expect(
      merged.zones.find((zone) => zone.roleId === 'worker' && zone.displayId === 2)?.rect
    ).toEqual({ x: 0, y: 0, w: 1, h: 1 })
    expect(
      merged.zones.find((zone) => zone.roleId === 'worker' && zone.displayId === 1)?.rect.w
    ).toBeCloseTo(600 / 1920)

    const plan = planLiveReflow({
      displays: [PRIMARY, SECOND],
      previousDisplayId: PRIMARY.id,
      existingZones: existing,
      movedId: 'left',
      nextRect: { x: 0, y: 0, width: 600, height: 1080 },
      windows: [
        { agentId: 'left', roleId: 'worker', bounds: { x: 0, y: 0, width: 960, height: 1080 } },
        { agentId: 'right', roleId: 'reviewer', bounds: { x: 960, y: 0, width: 960, height: 1080 } }
      ]
    })

    expect(
      plan!.zones.zones.map((zone) => `${zone.roleId}:${zone.displayId}`).sort()
    ).toEqual(['orchestrator:1', 'reviewer:1', 'worker:1', 'worker:2'])
  })

  it('keeps the profile’s chosen screen when live reflow rewrites rectangles', () => {
    const existing = zoneLayoutSchema.parse({
      targetDisplayId: SECOND.id,
      targetWorkArea: SECOND.workArea,
      zones: [{ roleId: 'worker', displayId: 2, rect: { x: 0, y: 0, w: 0.5, h: 1 } }]
    })
    const live = layout({ roleId: 'worker', displayId: 2, rect: { x: 0, y: 0, w: 0.4, h: 1 } })
    const merged = mergeLiveReflowZones(existing, live, [SECOND.id])
    expect(merged.targetDisplayId).toBe(SECOND.id)
    expect(merged.targetWorkArea).toEqual(SECOND.workArea)

    const plan = planLiveReflow({
      displays: [PRIMARY, SECOND],
      previousDisplayId: SECOND.id,
      existingZones: existing,
      movedId: 'left',
      nextRect: { x: 1920, y: 0, width: 600, height: 900 },
      windows: [
        { agentId: 'left', roleId: 'worker', bounds: { x: 1920, y: 0, width: 800, height: 900 } }
      ]
    })
    expect(plan!.zones.targetDisplayId).toBe(SECOND.id)
    expect(plan!.zones.targetWorkArea).toEqual(SECOND.workArea)
  })

  it('pins a window that crossed displays and lets the remainder fill the origin', () => {
    const plan = planLiveReflow({
      displays: [PRIMARY, SECOND],
      previousDisplayId: PRIMARY.id,
      movedId: 'gone',
      nextRect: { x: 2000, y: 10, width: 700, height: 500 },
      windows: [
        { agentId: 'gone', roleId: 'worker', bounds: { x: 0, y: 0, width: 960, height: 1080 } },
        { agentId: 'stay', roleId: 'reviewer', bounds: { x: 960, y: 0, width: 960, height: 1080 } }
      ]
    })

    expect(plan!.markMoved).toEqual(['gone'])
    const stay = plan!.placements.find((entry) => entry.agentId === 'stay')!.bounds
    expect(stay).toEqual(PRIMARY.workArea)
    expect(plan!.placements.find((entry) => entry.agentId === 'gone')).toBeUndefined()
  })

  it('does not mark movedByUser when reflow is on; debounce waits for flush', () => {
    let clock = 1_000
    resetPlacementStateForTesting(() => clock)
    setReflowNeighborsGetter(() => true)
    const seen: string[] = []
    setLiveReflowHandler((agentId) => seen.push(agentId))

    const events = new Map<string, () => void>()
    const win: MovableWindow = {
      on: (event, handler) => events.set(event, handler),
      setBounds: () => undefined
    }
    trackWindowMoves('a', win, () => clock)
    clock += 5_000
    events.get('move')!()
    expect(isMovedByUser('a')).toBe(false)
    expect(seen).toEqual([])

    clock += REFLOW_DEBOUNCE_MS - 1
    flushLiveReflow()
    expect(seen).toEqual([])

    clock += 1
    flushLiveReflow()
    expect(seen).toEqual(['a'])
    expect(isMovedByUser('a')).toBe(false)
  })

  it('does not schedule live reflow while move tracking is suppressed', () => {
    let clock = 1_000
    resetPlacementStateForTesting(() => clock)
    setReflowNeighborsGetter(() => true)
    const seen: string[] = []
    setLiveReflowHandler((agentId) => seen.push(agentId))

    const events = new Map<string, () => void>()
    const win: MovableWindow = {
      on: (event, handler) => events.set(event, handler),
      setBounds: () => undefined
    }
    trackWindowMoves('a', win, () => clock)
    clock += 5_000
    suppressMoveTracking('a', () => clock)
    events.get('move')!()
    clock += REFLOW_DEBOUNCE_MS
    flushLiveReflow()
    expect(seen).toEqual([])
    expect(isMovedByUser('a')).toBe(false)
  })

  it('cancels a pending live reflow when hide/show suppress runs', () => {
    let clock = 1_000
    resetPlacementStateForTesting(() => clock)
    setReflowNeighborsGetter(() => true)
    const seen: string[] = []
    setLiveReflowHandler((agentId) => seen.push(agentId))

    const events = new Map<string, () => void>()
    const win: MovableWindow = {
      on: (event, handler) => events.set(event, handler),
      setBounds: () => undefined
    }
    trackWindowMoves('a', win, () => clock)
    clock += 5_000
    events.get('move')!()
    suppressMoveTracking('a', () => clock)
    clock += REFLOW_DEBOUNCE_MS
    flushLiveReflow()
    expect(seen).toEqual([])
  })

  it('cancels a pending live reflow when the window is forgotten', () => {
    let clock = 1_000
    resetPlacementStateForTesting(() => clock)
    setReflowNeighborsGetter(() => true)
    const seen: string[] = []
    setLiveReflowHandler((agentId) => seen.push(agentId))

    const events = new Map<string, () => void>()
    const win: MovableWindow = {
      on: (event, handler) => events.set(event, handler),
      setBounds: () => undefined
    }
    trackWindowMoves('a', win, () => clock)
    clock += 5_000
    events.get('move')!()
    forgetWindowPlacement('a')
    clock += REFLOW_DEBOUNCE_MS
    flushLiveReflow()
    expect(seen).toEqual([])
  })
})
