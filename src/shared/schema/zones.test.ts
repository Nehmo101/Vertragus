import { describe, expect, it } from 'vitest'
import {
  absToRelRect,
  MAX_ZONES,
  MIN_ZONE_FRACTION,
  relRectSchema,
  resolveZoneRect,
  zoneLayoutSchema,
  zoneSchema,
  zonesForRole,
  type DisplayLike
} from './zones'

const displays: DisplayLike[] = [
  { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
  // Second monitor to the left with a negative origin — the case that breaks
  // naive percentage math.
  { id: 2, workArea: { x: -1280, y: 100, width: 1280, height: 900 } }
]

describe('relRectSchema', () => {
  it('rejects a zone that is too small to hold a terminal', () => {
    expect(relRectSchema.safeParse({ x: 0, y: 0, w: 0.04, h: 0.5 }).success).toBe(false)
    expect(relRectSchema.safeParse({ x: 0, y: 0, w: MIN_ZONE_FRACTION, h: 0.5 }).success).toBe(true)
  })

  it('rejects coordinates outside the unit square and unknown fields', () => {
    expect(relRectSchema.safeParse({ x: -0.1, y: 0, w: 0.5, h: 0.5 }).success).toBe(false)
    expect(relRectSchema.safeParse({ x: 0, y: 1.2, w: 0.5, h: 0.5 }).success).toBe(false)
    expect(relRectSchema.safeParse({ x: 0, y: 0, w: 0.5, h: 0.5, z: 1 }).success).toBe(false)
  })
})

describe('zoneSchema / zoneLayoutSchema', () => {
  it('requires an integer display id', () => {
    const rect = { x: 0, y: 0, w: 0.5, h: 0.5 }
    expect(zoneSchema.safeParse({ roleId: 'worker', displayId: 1.5, rect }).success).toBe(false)
    expect(zoneSchema.safeParse({ roleId: 'worker', displayId: 1, rect }).success).toBe(true)
  })

  it('defaults to an empty layout and caps the zone count', () => {
    expect(zoneLayoutSchema.parse({})).toEqual({ zones: [] })
    const zones = Array.from({ length: MAX_ZONES + 1 }, () => ({
      roleId: 'worker',
      displayId: 1,
      rect: { x: 0, y: 0, w: 0.5, h: 0.5 }
    }))
    expect(zoneLayoutSchema.safeParse({ zones }).success).toBe(false)
  })
})

describe('resolveZoneRect', () => {
  it('maps a relative rect onto the display work area', () => {
    const rect = resolveZoneRect(
      { displayId: 1, rect: { x: 0.5, y: 0, w: 0.5, h: 1 } },
      displays
    )
    expect(rect).toEqual({ x: 960, y: 0, width: 960, height: 1040 })
  })

  it('respects a negative work-area origin on a secondary monitor', () => {
    const rect = resolveZoneRect(
      { displayId: 2, rect: { x: 0, y: 0.5, w: 1, h: 0.5 } },
      displays
    )
    expect(rect).toEqual({ x: -1280, y: 550, width: 1280, height: 450 })
  })

  it('returns null when the display is not attached (auto-tiling takes over)', () => {
    expect(resolveZoneRect({ displayId: 99, rect: { x: 0, y: 0, w: 1, h: 1 } }, displays)).toBeNull()
    expect(resolveZoneRect({ displayId: 1, rect: { x: 0, y: 0, w: 1, h: 1 } }, [])).toBeNull()
  })

  it('rematches a stale Electron display id when only one monitor is attached', () => {
    // Windows: Display.id often changes across sessions while the work area
    // stays put. With a single monitor there is nothing else to guess.
    const rect = resolveZoneRect(
      { displayId: 99, rect: { x: 0.5, y: 0, w: 0.5, h: 1 } },
      [{ id: 7, workArea: displays[0]!.workArea }]
    )
    expect(rect).toEqual({ x: 960, y: 0, width: 960, height: 1040 })
  })

  it('keeps a rect that would overflow inside the work area', () => {
    const rect = resolveZoneRect({ displayId: 1, rect: { x: 0.9, y: 0.9, w: 0.5, h: 0.5 } }, displays)
    expect(rect).toEqual({ x: 960, y: 520, width: 960, height: 520 })
  })
})

describe('absToRelRect', () => {
  it('round-trips a dragged rect back to the same pixels', () => {
    const workArea = displays[0]!.workArea
    const abs = { x: 480, y: 260, width: 960, height: 520 }
    const rel = absToRelRect(abs, workArea)
    expect(relRectSchema.safeParse(rel).success).toBe(true)
    expect(resolveZoneRect({ displayId: 1, rect: rel }, displays)).toEqual(abs)
  })

  it('handles a negative work-area origin', () => {
    const workArea = displays[1]!.workArea
    const abs = { x: -1280, y: 100, width: 640, height: 450 }
    const rel = absToRelRect(abs, workArea)
    expect(rel).toEqual({ x: 0, y: 0, w: 0.5, h: 0.5 })
  })

  it('clamps a sloppy drag into a rect the schema still accepts', () => {
    const workArea = displays[0]!.workArea
    const rel = absToRelRect({ x: -400, y: -400, width: 4, height: 4 }, workArea)
    expect(relRectSchema.safeParse(rel).success).toBe(true)
    expect(rel).toEqual({ x: 0, y: 0, w: MIN_ZONE_FRACTION, h: MIN_ZONE_FRACTION })
  })

  it('degrades to a minimal rect for a zero-sized work area', () => {
    const rel = absToRelRect({ x: 0, y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: 0, height: 0 })
    expect(relRectSchema.safeParse(rel).success).toBe(true)
  })
})

describe('zonesForRole', () => {
  it('returns every zone of one role in layout order', () => {
    const layout = zoneLayoutSchema.parse({
      zones: [
        { roleId: 'worker', displayId: 1, rect: { x: 0, y: 0, w: 0.5, h: 0.5 } },
        { roleId: 'reviewer', displayId: 1, rect: { x: 0.5, y: 0, w: 0.5, h: 0.5 } },
        { roleId: 'worker', displayId: 2, rect: { x: 0, y: 0, w: 1, h: 1 } }
      ]
    })
    expect(zonesForRole(layout, 'worker').map((zone) => zone.displayId)).toEqual([1, 2])
    expect(zonesForRole(undefined, 'worker')).toEqual([])
  })
})
