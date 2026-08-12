import { describe, expect, it } from 'vitest'
import { MIN_ZONE_FRACTION } from '@shared/schema/zones'
import type { ZoneEditorRole } from '../../../preload'
import { autoLayoutRects } from './autoLayout'
import { clampMove, clampResize, minZoneSize, pxToRel, type PxRect, type Viewport } from './geometry'

const VIEW: Viewport = { width: 1920, height: 1040 }
const SMALL: Viewport = { width: 800, height: 600 }

function roles(count: number): ZoneEditorRole[] {
  return Array.from({ length: count }, (_, index) => ({
    roleId: index === 0 ? 'orchestrator' : `role-${index}`,
    label: index === 0 ? 'Orchestrator' : `Role ${index}`,
    color: '#cba35a'
  }))
}

function area(rect: PxRect): number {
  return rect.width * rect.height
}

function overlaps(a: PxRect, b: PxRect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

function assertValidLayout(rects: PxRect[], viewport: Viewport, expectedCount: number): void {
  expect(rects).toHaveLength(expectedCount)
  const min = minZoneSize(viewport)

  for (const rect of rects) {
    expect(rect.x).toBeGreaterThanOrEqual(0)
    expect(rect.y).toBeGreaterThanOrEqual(0)
    expect(rect.x + rect.width).toBeLessThanOrEqual(viewport.width)
    expect(rect.y + rect.height).toBeLessThanOrEqual(viewport.height)
    expect(rect.width).toBeGreaterThanOrEqual(min.width)
    expect(rect.height).toBeGreaterThanOrEqual(min.height)
    expect(rect.width / viewport.width).toBeGreaterThanOrEqual(MIN_ZONE_FRACTION)
    expect(rect.height / viewport.height).toBeGreaterThanOrEqual(MIN_ZONE_FRACTION)
    // clampResize / clampMove must be no-ops — schema-safe as drawn.
    expect(clampResize(rect, viewport)).toEqual(rect)
    expect(clampMove(rect, viewport)).toEqual(rect)
    expect(() => pxToRel(rect, viewport)).not.toThrow()
  }

  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      expect(overlaps(rects[i]!, rects[j]!)).toBe(false)
    }
  }

  const covered = rects.reduce((sum, rect) => sum + area(rect), 0)
  expect(covered).toBe(viewport.width * viewport.height)
}

describe('autoLayoutRects', () => {
  it('returns nothing for an empty palette', () => {
    expect(autoLayoutRects([], VIEW)).toEqual([])
  })

  it('fills the screen for a single role', () => {
    const rects = autoLayoutRects(roles(1), VIEW)
    assertValidLayout(rects, VIEW, 1)
    expect(rects[0]).toEqual({ x: 0, y: 0, width: VIEW.width, height: VIEW.height })
  })

  it('splits two roles side by side', () => {
    const rects = autoLayoutRects(roles(2), VIEW)
    assertValidLayout(rects, VIEW, 2)
    expect(rects[0]!.y).toBe(0)
    expect(rects[1]!.y).toBe(0)
    expect(rects[0]!.height).toBe(VIEW.height)
    expect(rects[1]!.height).toBe(VIEW.height)
    expect(rects[0]!.x + rects[0]!.width).toBe(rects[1]!.x)
  })

  it('gives the orchestrator a left column when three or more roles are present', () => {
    const rects = autoLayoutRects(roles(3), VIEW)
    assertValidLayout(rects, VIEW, 3)
    expect(rects[0]!.x).toBe(0)
    expect(rects[0]!.y).toBe(0)
    expect(rects[0]!.height).toBe(VIEW.height)
    expect(rects[0]!.width).toBe(Math.round(VIEW.width * 0.38))
    for (const rect of rects.slice(1)) {
      expect(rect.x).toBeGreaterThanOrEqual(rects[0]!.width)
    }
  })

  it.each([3, 5, 7])('lays out %i roles without gaps or overlaps', (count) => {
    assertValidLayout(autoLayoutRects(roles(count), VIEW), VIEW, count)
  })

  it('is deterministic', () => {
    const first = autoLayoutRects(roles(5), VIEW)
    const second = autoLayoutRects(roles(5), VIEW)
    expect(second).toEqual(first)
  })

  it('respects minZoneSize on a small 800×600 viewport', () => {
    for (const count of [1, 2, 3, 5, 7]) {
      assertValidLayout(autoLayoutRects(roles(count), SMALL), SMALL, count)
    }
  })
})
