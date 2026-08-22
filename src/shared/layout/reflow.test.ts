import { describe, expect, it } from 'vitest'
import { reflowNeighbors, type Rect } from './reflow'

const bounds: Rect = { x: 0, y: 0, width: 1920, height: 1040 }
const minWidth = 380
const minHeight = 260

function pane3(): Array<{ id: string; rect: Rect }> {
  return [
    { id: 'o', rect: { x: 0, y: 0, width: 730, height: 1040 } },
    { id: 'w', rect: { x: 730, y: 0, width: 1190, height: 520 } },
    { id: 't', rect: { x: 730, y: 520, width: 1190, height: 520 } }
  ]
}

function overlapArea(a: Rect, b: Rect): number {
  const x = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  const y = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  return x * y
}

function byId(items: Array<{ id: string; rect: Rect }>, id: string): Rect {
  const found = items.find((item) => item.id === id)
  expect(found).toBeTruthy()
  return found!.rect
}

function expectNoOverlap(items: Array<{ id: string; rect: Rect }>): void {
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      expect(overlapArea(items[i]!.rect, items[j]!.rect), `${items[i]!.id} vs ${items[j]!.id}`).toBe(0)
    }
  }
}

function expectCoversBounds(items: Array<{ id: string; rect: Rect }>, box: Rect, slackPx = 1): void {
  for (const item of items) {
    expect(item.rect.x).toBeGreaterThanOrEqual(box.x - slackPx)
    expect(item.rect.y).toBeGreaterThanOrEqual(box.y - slackPx)
    expect(item.rect.x + item.rect.width).toBeLessThanOrEqual(box.x + box.width + slackPx)
    expect(item.rect.y + item.rect.height).toBeLessThanOrEqual(box.y + box.height + slackPx)
  }
  const covered = items.reduce((sum, item) => sum + item.rect.width * item.rect.height, 0)
  const hole = box.width * box.height - covered
  expect(hole).toBeLessThanOrEqual(slackPx * (box.width + box.height))
}

describe('reflowNeighbors', () => {
  it('returns a copy unchanged when movedId is missing', () => {
    const rects = [{ id: 'a', rect: { x: 8, y: 16, width: 40, height: 50 } }]
    const nextRect = { x: 0, y: 0, width: 100, height: 100 }
    const result = reflowNeighbors({
      rects,
      movedId: 'missing',
      nextRect,
      bounds,
      minWidth,
      minHeight
    })
    expect(result).toEqual(rects)
    expect(result).not.toBe(rects)
    expect(result[0]!.rect).not.toBe(rects[0]!.rect)
    result[0]!.rect.x = 99
    expect(rects[0]!.rect.x).toBe(8)
  })

  it('clamps a single rect inside bounds', () => {
    const box: Rect = { x: 10, y: 20, width: 100, height: 80 }
    const result = reflowNeighbors({
      rects: [{ id: 'only', rect: { x: 0, y: 0, width: 10, height: 10 } }],
      movedId: 'only',
      nextRect: { x: -40, y: -40, width: 8000, height: 8000 },
      bounds: box,
      minWidth,
      minHeight
    })
    // Bounds are smaller than min — fill the work area rather than overflow it.
    expect(result).toEqual([{ id: 'only', rect: { x: 10, y: 20, width: 100, height: 80 } }])
  })

  it('widens the left pane and keeps the right stack tiled', () => {
    const result = reflowNeighbors({
      rects: pane3(),
      movedId: 'o',
      nextRect: { x: 0, y: 0, width: 900, height: 1040 },
      bounds,
      minWidth,
      minHeight
    })
    expect(result.map((item) => item.id)).toEqual(['o', 'w', 't'])
    const w = byId(result, 'w')
    const t = byId(result, 't')
    expect(w.x).toBe(900)
    expect(t.x).toBe(900)
    expect(w.width).toBe(1020)
    expect(t.width).toBe(1020)
    expect(w.y).toBeLessThan(t.y)
    expect(Math.abs(w.y + w.height - t.y)).toBeLessThanOrEqual(1)
    expectNoOverlap(result)
    expectCoversBounds(result, bounds)
  })

  it('keeps tiling closed when the upper-right pane moves down by 100px', () => {
    // Bottom edge travels 100px; a pure translate would leave a hole only the
    // moved pane could fill, and the moved rect is not expanded.
    const result = reflowNeighbors({
      rects: pane3(),
      movedId: 'w',
      nextRect: { x: 730, y: 0, width: 1190, height: 620 },
      bounds,
      minWidth,
      minHeight
    })
    expectNoOverlap(result)
    expectCoversBounds(result, bounds)
  })

  it('does not crush the bottom pane below minHeight when o or w eats it', () => {
    const eatenByW = reflowNeighbors({
      rects: pane3(),
      movedId: 'w',
      nextRect: { x: 730, y: 0, width: 1190, height: 1040 },
      bounds,
      minWidth,
      minHeight
    })
    expect(byId(eatenByW, 't').height).toBeGreaterThanOrEqual(minHeight)
    expect(byId(eatenByW, 't').width).toBeGreaterThanOrEqual(minWidth)
    expectNoOverlap(eatenByW)

    const eatenByO = reflowNeighbors({
      rects: pane3(),
      movedId: 'o',
      nextRect: { x: 0, y: 0, width: 1920, height: 1040 },
      bounds,
      minWidth,
      minHeight
    })
    expect(byId(eatenByO, 't').height).toBeGreaterThanOrEqual(minHeight)
    expect(byId(eatenByO, 't').width).toBeGreaterThanOrEqual(minWidth)
    expectNoOverlap(eatenByO)
  })

  it('returns equal results for two identical calls', () => {
    const input = {
      rects: pane3(),
      movedId: 'o',
      nextRect: { x: 0, y: 0, width: 900, height: 1040 },
      bounds,
      minWidth,
      minHeight
    }
    expect(reflowNeighbors(input)).toEqual(reflowNeighbors(input))
  })
})
