import { describe, expect, it } from 'vitest'
import { MIN_ZONE_FRACTION } from '@shared/schema/zones'
import {
  clampMove,
  clampResize,
  draftsToZones,
  minZoneSize,
  newZoneRect,
  pxToRel,
  relToPx,
  type DraftZone,
  type Viewport
} from './geometry'

const VIEW: Viewport = { width: 1920, height: 1040 }

describe('clamping', () => {
  it('keeps a dragged zone fully on screen', () => {
    expect(clampMove({ x: -400, y: -400, width: 600, height: 400 }, VIEW)).toEqual({
      x: 0,
      y: 0,
      width: 600,
      height: 400
    })
    expect(clampMove({ x: 5000, y: 5000, width: 600, height: 400 }, VIEW)).toEqual({
      x: 1320,
      y: 640,
      width: 600,
      height: 400
    })
  })

  it('refuses to shrink a zone below a readable terminal', () => {
    const tiny = clampResize({ x: 0, y: 0, width: 5, height: 5 }, VIEW)
    const min = minZoneSize(VIEW)
    expect(tiny.width).toBe(min.width)
    expect(tiny.height).toBe(min.height)
    // …and never below the schema's floor either.
    expect(tiny.width / VIEW.width).toBeGreaterThanOrEqual(MIN_ZONE_FRACTION)
    expect(tiny.height / VIEW.height).toBeGreaterThanOrEqual(MIN_ZONE_FRACTION)
  })

  it('does not let a resize run past the right or bottom edge', () => {
    const wide = clampResize({ x: 1500, y: 900, width: 5000, height: 5000 }, VIEW)
    expect(wide.x + wide.width).toBe(VIEW.width)
    expect(wide.y + wide.height).toBe(VIEW.height)
  })
})

describe('relative ↔ pixel', () => {
  it('round-trips a rect through the persisted form', () => {
    const rect = { x: 480, y: 260, width: 960, height: 520 }
    const back = relToPx(pxToRel(rect, VIEW), VIEW)
    expect(back).toEqual(rect)
  })

  it('stores fractions of the work area, not pixels', () => {
    expect(pxToRel({ x: 960, y: 0, width: 960, height: 1040 }, VIEW)).toEqual({
      x: 0.5,
      y: 0,
      w: 0.5,
      h: 1
    })
  })

  it('survives a monitor that got smaller since the zone was drawn', () => {
    const rel = pxToRel({ x: 960, y: 0, width: 960, height: 1040 }, VIEW)
    const small = relToPx(rel, { width: 1280, height: 720 })
    expect(small.x + small.width).toBeLessThanOrEqual(1280)
    expect(small.y + small.height).toBeLessThanOrEqual(720)
  })
})

describe('new zones', () => {
  it('drops a readable block that cascades instead of stacking', () => {
    const first = newZoneRect(VIEW, 0)
    const second = newZoneRect(VIEW, 1)

    expect(first.width).toBeGreaterThan(minZoneSize(VIEW).width)
    expect(second.x).toBeGreaterThan(first.x)
    expect(second.y).toBeGreaterThan(first.y)
    expect(clampMove(second, VIEW)).toEqual(second)
  })

  it('still fits on a very small display', () => {
    const small: Viewport = { width: 800, height: 600 }
    const rect = newZoneRect(small, 5)
    expect(rect.x + rect.width).toBeLessThanOrEqual(small.width)
    expect(rect.y + rect.height).toBeLessThanOrEqual(small.height)
  })
})

describe('draftsToZones', () => {
  it('stamps every zone with the display it was drawn on', () => {
    const drafts: DraftZone[] = [
      {
        id: 'z1',
        roleId: 'worker',
        label: 'Worker',
        color: '#2f7d6d',
        rect: { x: 0, y: 0, width: 960, height: 1040 }
      },
      {
        id: 'z2',
        roleId: 'orchestrator',
        label: 'Orchestrator',
        color: '#cba35a',
        rect: { x: 960, y: 0, width: 960, height: 520 }
      }
    ]

    expect(draftsToZones(drafts, 42, VIEW)).toEqual([
      { roleId: 'worker', displayId: 42, rect: { x: 0, y: 0, w: 0.5, h: 1 } },
      { roleId: 'orchestrator', displayId: 42, rect: { x: 0.5, y: 0, w: 0.5, h: 0.5 } }
    ])
  })
})
