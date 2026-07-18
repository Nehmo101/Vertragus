import { describe, expect, it } from 'vitest'
import {
  NOTE_NODE_HEIGHT,
  NOTE_NODE_WIDTH,
  ORCH_NODE_HEIGHT,
  ORCH_NODE_WIDTH,
  TASK_NODE_HEIGHT,
  TASK_NODE_WIDTH,
  type NodePosition
} from './canvasGraph'
import {
  findFreeCanvasSlot,
  placeCanvasSlots,
  rectOverlapsAny,
  rectsOverlap,
  type CanvasRect
} from './canvasSlots'

function rect(x: number, y: number, width: number, height: number): CanvasRect {
  return { x, y, width, height }
}

function asRect(position: NodePosition, width: number, height: number): CanvasRect {
  return { ...position, width, height }
}

function assertNoPairOverlaps(rects: readonly CanvasRect[], gap = 0): void {
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      expect(
        rectsOverlap(rects[i]!, rects[j]!, gap),
        `overlap between #${i} and #${j}`
      ).toBe(false)
    }
  }
}

describe('rectsOverlap', () => {
  it('detects intersection and respects a positive gap as clear space', () => {
    expect(rectsOverlap(rect(0, 0, 10, 10), rect(5, 5, 10, 10))).toBe(true)
    expect(rectsOverlap(rect(0, 0, 10, 10), rect(10, 0, 10, 10))).toBe(false)
    expect(rectsOverlap(rect(0, 0, 10, 10), rect(10, 0, 10, 10), 1)).toBe(true)
    expect(rectsOverlap(rect(0, 0, 10, 10), rect(11, 0, 10, 10), 1)).toBe(false)
  })
})

describe('findFreeCanvasSlot', () => {
  it('returns the preferred start when the board is empty', () => {
    expect(
      findFreeCanvasSlot([], { width: TASK_NODE_WIDTH, height: TASK_NODE_HEIGHT }, {
        preferred: { x: 40, y: 80 }
      })
    ).toEqual({ x: 40, y: 80 })
  })

  it('skips an occupied preferred start and lands on the next free grid cell', () => {
    const occupied = [rect(0, 0, TASK_NODE_WIDTH, TASK_NODE_HEIGHT)]
    const gap = 18
    const placed = findFreeCanvasSlot(
      occupied,
      { width: TASK_NODE_WIDTH, height: TASK_NODE_HEIGHT },
      { preferred: { x: 0, y: 0 }, gap }
    )

    expect(placed).toEqual({ x: TASK_NODE_WIDTH + gap, y: 0 })
    expect(
      rectOverlapsAny(asRect(placed, TASK_NODE_WIDTH, TASK_NODE_HEIGHT), occupied, gap)
    ).toBe(false)
  })

  it('never overlaps existing slots across multiple sequential insertions', () => {
    const gap = 18
    const occupied: CanvasRect[] = []
    const sizes = [
      { width: TASK_NODE_WIDTH, height: TASK_NODE_HEIGHT },
      { width: ORCH_NODE_WIDTH, height: ORCH_NODE_HEIGHT },
      { width: NOTE_NODE_WIDTH, height: NOTE_NODE_HEIGHT },
      { width: 120, height: 80 },
      { width: 300, height: 140 }
    ]

    for (const size of sizes) {
      const position = findFreeCanvasSlot(occupied, size, {
        preferred: { x: 0, y: 0 },
        gap
      })
      const next = asRect(position, size.width, size.height)
      expect(rectOverlapsAny(next, occupied, gap)).toBe(false)
      occupied.push(next)
    }

    assertNoPairOverlaps(occupied, gap)
  })

  it('honours different gaps and step sizes without colliding', () => {
    const occupied = [
      rect(0, 0, 100, 100),
      rect(160, 0, 100, 100),
      rect(0, 160, 100, 100)
    ]
    const gap = 40
    const placed = findFreeCanvasSlot(
      occupied,
      { width: 100, height: 100 },
      { preferred: { x: 0, y: 0 }, gap, stepX: 160, stepY: 160, columns: 3 }
    )

    expect(rectOverlapsAny(asRect(placed, 100, 100), occupied, gap)).toBe(false)
    // Row-major scan: (0,0) and (160,0) are taken → next free cell is (320,0).
    expect(placed).toEqual({ x: 320, y: 0 })
  })

  it('is deterministic for identical occupied sets and options', () => {
    const occupied = [
      rect(24, 32, NOTE_NODE_WIDTH, NOTE_NODE_HEIGHT),
      rect(24 + NOTE_NODE_WIDTH + 18, 32, NOTE_NODE_WIDTH, NOTE_NODE_HEIGHT)
    ]
    const size = { width: NOTE_NODE_WIDTH, height: NOTE_NODE_HEIGHT }
    const options = { preferred: { x: 24, y: 32 }, gap: 18, columns: 8 }

    expect(findFreeCanvasSlot(occupied, size, options)).toEqual(
      findFreeCanvasSlot(occupied, size, options)
    )
    expect(findFreeCanvasSlot(occupied, size, options)).toEqual({
      x: 24 + 2 * (NOTE_NODE_WIDTH + 18),
      y: 32
    })
  })

  it('rejects non-positive sizes instead of inventing a slot', () => {
    expect(() => findFreeCanvasSlot([], { width: 0, height: 10 })).toThrow(/positive/)
    expect(() => findFreeCanvasSlot([], { width: 10, height: -1 })).toThrow(/positive/)
  })
})

describe('placeCanvasSlots', () => {
  it('places a batch so every new slot clears prior occupied and siblings', () => {
    const gap = 18
    const seed = [rect(0, 0, TASK_NODE_WIDTH, TASK_NODE_HEIGHT)]
    const sizes = [
      { width: TASK_NODE_WIDTH, height: TASK_NODE_HEIGHT },
      { width: TASK_NODE_WIDTH, height: TASK_NODE_HEIGHT },
      { width: NOTE_NODE_WIDTH, height: NOTE_NODE_HEIGHT }
    ]

    const positions = placeCanvasSlots(seed, sizes, { preferred: { x: 0, y: 0 }, gap })
    expect(positions).toHaveLength(sizes.length)

    const all = [
      ...seed,
      ...positions.map((position, index) =>
        asRect(position, sizes[index]!.width, sizes[index]!.height)
      )
    ]
    assertNoPairOverlaps(all, gap)
  })

  it('keeps successive batches non-overlapping when the board fills', () => {
    const gap = 12
    let board: CanvasRect[] = [rect(10, 10, 80, 60)]

    for (let batch = 0; batch < 3; batch++) {
      const sizes = [
        { width: 80, height: 60 },
        { width: 140, height: 90 }
      ]
      const positions = placeCanvasSlots(board, sizes, {
        preferred: { x: 10, y: 10 },
        gap,
        stepX: 80 + gap,
        stepY: 60 + gap,
        columns: 6
      })
      board = [
        ...board,
        ...positions.map((position, index) =>
          asRect(position, sizes[index]!.width, sizes[index]!.height)
        )
      ]
    }

    assertNoPairOverlaps(board, gap)
    expect(board).toHaveLength(1 + 3 * 2)
  })
})
