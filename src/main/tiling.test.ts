import { describe, expect, it } from 'vitest'
import { availableArea, computeTiles, snapRailPosition, type Rect } from './tiling'

const WORK: Rect = { x: 0, y: 0, width: 1920, height: 1040 }

function overlaps(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width && b.x < a.x + a.width &&
    a.y < b.y + b.height && b.y < a.y + a.height
  )
}

describe('availableArea', () => {
  it('reserves the rail strip on its edge', () => {
    const left = availableArea(WORK, 'left', 292)
    expect(left.x).toBe(300)
    expect(left.width).toBe(1620)
    const right = availableArea(WORK, 'right', 292)
    expect(right.x).toBe(0)
    expect(right.width).toBe(1620)
  })

  it('keeps the full area without a docked rail', () => {
    expect(availableArea(WORK, undefined, 292)).toEqual(WORK)
  })
})

describe('computeTiles', () => {
  it('gives a single window the whole available area', () => {
    const [tile] = computeTiles({ workArea: WORK, railWidth: 0, count: 1 })
    expect(tile).toEqual({ x: 0, y: 0, width: 1920, height: 1040 })
  })

  it('tiles 4 windows as an overlap-free grid', () => {
    const tiles = computeTiles({ workArea: WORK, railWidth: 0, count: 4 })
    expect(tiles).toHaveLength(4)
    for (let i = 0; i < tiles.length; i += 1) {
      for (let j = i + 1; j < tiles.length; j += 1) {
        expect(overlaps(tiles[i]!, tiles[j]!), `tiles ${i}/${j} overlap`).toBe(false)
      }
      expect(tiles[i]!.width).toBeGreaterThanOrEqual(420)
      expect(tiles[i]!.height).toBeGreaterThanOrEqual(300)
    }
  })

  it('puts the orchestrator (primaryIndex) into the first cell', () => {
    const tiles = computeTiles({ workArea: WORK, railWidth: 0, count: 4, primaryIndex: 2 })
    // Der Orchestrator (Index 2) bekommt die oberste linke Zelle.
    const first = [...tiles].sort((a, b) => a.y - b.y || a.x - b.x)[0]!
    expect(tiles[2]).toEqual(first)
  })

  it('widens the orchestrator when a single row has a spare cell', () => {
    // 3 Fenster auf breiter Fläche → einreihig; count=3 mit cols=4 gibt es
    // nicht, also konstruiert: 3 Fenster, Fläche für 4 Spalten.
    const tiles = computeTiles({
      workArea: { x: 0, y: 0, width: 1800, height: 320 },
      railWidth: 0,
      count: 3,
      primaryIndex: 0,
      minH: 300
    })
    expect(tiles).toHaveLength(3)
    // Alle in einer Reihe, keine Überlappung.
    for (let i = 1; i < tiles.length; i += 1) {
      expect(overlaps(tiles[0]!, tiles[i]!)).toBe(false)
    }
  })

  it('subtracts a docked rail from the grid', () => {
    const tiles = computeTiles({ workArea: WORK, railEdge: 'right', railWidth: 292, count: 2 })
    for (const tile of tiles) {
      expect(tile.x + tile.width).toBeLessThanOrEqual(1920 - 292 - 8)
    }
  })

  it('cascades windows beyond the overlap-free capacity instead of zero-sizing', () => {
    const tiles = computeTiles({
      workArea: { x: 0, y: 0, width: 900, height: 640 },
      railWidth: 0,
      count: 12
    })
    expect(tiles).toHaveLength(12)
    for (const tile of tiles) {
      expect(tile.width).toBeGreaterThanOrEqual(300)
      expect(tile.height).toBeGreaterThanOrEqual(300)
      expect(tile.x).toBeGreaterThanOrEqual(0)
      expect(tile.y).toBeGreaterThanOrEqual(0)
    }
  })

  it('returns nothing for zero windows', () => {
    expect(computeTiles({ workArea: WORK, railWidth: 0, count: 0 })).toEqual([])
  })
})

describe('snapRailPosition', () => {
  it('snaps to the left and right edges within the threshold', () => {
    expect(snapRailPosition(10, 100, WORK, 280, 600)).toEqual({ x: 0, y: 100, edge: 'left' })
    expect(snapRailPosition(1630, 100, WORK, 280, 600)).toEqual({ x: 1640, y: 100, edge: 'right' })
  })

  it('clamps y into the work area and keeps free positions unsnapped', () => {
    const free = snapRailPosition(800, -50, WORK, 280, 600)
    expect(free).toEqual({ x: 800, y: 0, edge: null })
    const low = snapRailPosition(800, 5000, WORK, 280, 600)
    expect(low.y).toBe(1040 - 600)
  })
})
