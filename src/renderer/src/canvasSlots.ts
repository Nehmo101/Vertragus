/**
 * Pure canvas slot placement: find free top-left positions so a new node
 * never overlaps existing occupied rectangles (including a configurable gap).
 *
 * Kept separate from `buildCanvasGraph` so dagre auto-layout and persisted
 * drag positions stay untouched; callers can resolve slots for brand-new nodes.
 */
import type { NodePosition } from './canvasGraph'

export interface CanvasRect {
  x: number
  y: number
  width: number
  height: number
}

export interface CanvasSlotSize {
  width: number
  height: number
}

export interface FindFreeCanvasSlotOptions {
  /** Preferred top-left; when occupied the search continues deterministically. */
  preferred?: NodePosition
  /** Minimum clear space between rectangles on each axis (default 18). */
  gap?: number
  /** Horizontal step while scanning (default: width + gap). */
  stepX?: number
  /** Vertical step when wrapping to the next row (default: height + gap). */
  stepY?: number
  /** Columns per search row before stepping down (default 12). */
  columns?: number
  /** Hard cap on grid probes; exhausted search throws (default 4096). */
  maxAttempts?: number
}

/** Axis-aligned overlap, expanding each rect by `gap` on the right/bottom. */
export function rectsOverlap(a: CanvasRect, b: CanvasRect, gap = 0): boolean {
  const pad = Math.max(0, gap)
  return (
    a.x < b.x + b.width + pad &&
    a.x + a.width + pad > b.x &&
    a.y < b.y + b.height + pad &&
    a.y + a.height + pad > b.y
  )
}

export function rectOverlapsAny(
  candidate: CanvasRect,
  occupied: readonly CanvasRect[],
  gap = 0
): boolean {
  return occupied.some((rect) => rectsOverlap(candidate, rect, gap))
}

/**
 * Deterministic free-slot search: start at `preferred` (or origin), then scan
 * left-to-right / top-to-bottom on a grid sized to the candidate. Occupied
 * preferred starts are skipped without moving existing rects.
 */
export function findFreeCanvasSlot(
  occupied: readonly CanvasRect[],
  size: CanvasSlotSize,
  options: FindFreeCanvasSlotOptions = {}
): NodePosition {
  const width = size.width
  const height = size.height
  if (!(width > 0) || !(height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error('canvas slot size must be finite and positive')
  }

  const gap = options.gap ?? 18
  const stepX = options.stepX ?? width + gap
  const stepY = options.stepY ?? height + gap
  const columns = options.columns ?? 12
  const maxAttempts = options.maxAttempts ?? 4096
  const originX = options.preferred?.x ?? 0
  const originY = options.preferred?.y ?? 0

  if (
    !Number.isFinite(stepX) ||
    !Number.isFinite(stepY) ||
    stepX <= 0 ||
    stepY <= 0 ||
    columns < 1
  ) {
    throw new Error('canvas slot search grid must use positive finite steps')
  }

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const col = attempt % columns
    const row = Math.floor(attempt / columns)
    const position = { x: originX + col * stepX, y: originY + row * stepY }
    const candidate: CanvasRect = { ...position, width, height }
    if (!rectOverlapsAny(candidate, occupied, gap)) return position
  }

  throw new Error(`no free canvas slot within ${maxAttempts} attempts`)
}

/**
 * Place several new slots in order. Each accepted position is treated as
 * occupied for the next insertion so successive inserts never collide.
 */
export function placeCanvasSlots(
  occupied: readonly CanvasRect[],
  sizes: readonly CanvasSlotSize[],
  options: FindFreeCanvasSlotOptions = {}
): NodePosition[] {
  const taken: CanvasRect[] = occupied.map((rect) => ({ ...rect }))
  const placed: NodePosition[] = []
  for (const size of sizes) {
    const position = findFreeCanvasSlot(taken, size, options)
    taken.push({ ...position, width: size.width, height: size.height })
    placed.push(position)
  }
  return placed
}
