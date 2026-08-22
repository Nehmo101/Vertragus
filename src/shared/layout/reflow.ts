export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface LayoutItem {
  id: string
  rect: Rect
}

type Edge = 'left' | 'right' | 'top' | 'bottom'

function copyRect(rect: Rect): Rect {
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
}

function roundRect(rect: Rect): Rect {
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height)
  }
}

function overlapX(a: Rect, b: Rect): number {
  return Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
}

function overlapY(a: Rect, b: Rect): number {
  return Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
}

/** Intersection area; shared edges are 0 so tiling seams are not collisions. */
function overlapArea(a: Rect, b: Rect): number {
  return overlapX(a, b) * overlapY(a, b)
}

function overlaps(a: Rect, b: Rect): boolean {
  return overlapX(a, b) > 0 && overlapY(a, b) > 0
}

function insideBounds(rect: Rect, bounds: Rect): boolean {
  return (
    rect.x >= bounds.x &&
    rect.y >= bounds.y &&
    rect.x + rect.width <= bounds.x + bounds.width &&
    rect.y + rect.height <= bounds.y + bounds.height
  )
}

/** Keep a rect inside bounds; if the work area itself is below min, fill the bounds. */
function clampRect(rect: Rect, bounds: Rect, minWidth: number, minHeight: number): Rect {
  const minW = Math.min(minWidth, bounds.width)
  const minH = Math.min(minHeight, bounds.height)
  const width = Math.min(bounds.width, Math.max(minW, Math.round(rect.width)))
  const height = Math.min(bounds.height, Math.max(minH, Math.round(rect.height)))
  const x = Math.min(bounds.x + bounds.width - width, Math.max(bounds.x, Math.round(rect.x)))
  const y = Math.min(bounds.y + bounds.height - height, Math.max(bounds.y, Math.round(rect.y)))
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) }
}

function shrinkFrom(rect: Rect, edge: Edge, amount: number, minWidth: number, minHeight: number): number {
  if (amount <= 0) return 0
  if (edge === 'left' || edge === 'right') {
    const delta = Math.min(amount, Math.max(0, rect.width - minWidth))
    if (edge === 'left') rect.x += delta
    rect.width -= delta
    return delta
  }
  const delta = Math.min(amount, Math.max(0, rect.height - minHeight))
  if (edge === 'top') rect.y += delta
  rect.height -= delta
  return delta
}

function opposite(edge: Edge): Edge {
  if (edge === 'left') return 'right'
  if (edge === 'right') return 'left'
  if (edge === 'top') return 'bottom'
  return 'top'
}

/** Nearer exit on X — the short push that separates without jumping to the far side. */
function neighborEdgeX(moved: Rect, neighbor: Rect): Edge {
  const shrinkLeft = moved.x + moved.width - neighbor.x
  const shrinkRight = neighbor.x + neighbor.width - moved.x
  return shrinkLeft <= shrinkRight ? 'left' : 'right'
}

function neighborEdgeY(moved: Rect, neighbor: Rect): Edge {
  const shrinkTop = moved.y + moved.height - neighbor.y
  const shrinkBottom = neighbor.y + neighbor.height - moved.y
  return shrinkTop <= shrinkBottom ? 'top' : 'bottom'
}

function resolveOverlap(
  moved: Rect,
  neighbor: Rect,
  minWidth: number,
  minHeight: number
): void {
  // A few axis swaps is enough; stop if a min-sized pair still intersects.
  for (let step = 0; step < 8; step += 1) {
    const ox = overlapX(moved, neighbor)
    const oy = overlapY(moved, neighbor)
    if (ox <= 0 || oy <= 0) return

    // Shared long edges make a large overlap on that axis; separate on the
    // short penetration so a column grow does not flatten the row stack.
    const edge = ox <= oy ? neighborEdgeX(moved, neighbor) : neighborEdgeY(moved, neighbor)
    const penetration = edge === 'left' || edge === 'right' ? ox : oy
    const fromNeighbor = shrinkFrom(neighbor, edge, penetration, minWidth, minHeight)
    const remainder = penetration - fromNeighbor
    if (remainder > 0) {
      shrinkFrom(moved, opposite(edge), remainder, minWidth, minHeight)
    }
    if (overlapArea(moved, neighbor) >= ox * oy) return
  }
}

function grown(rect: Rect, edge: Edge, delta: number): Rect {
  if (edge === 'left') return { x: rect.x - delta, y: rect.y, width: rect.width + delta, height: rect.height }
  if (edge === 'right') return { x: rect.x, y: rect.y, width: rect.width + delta, height: rect.height }
  if (edge === 'top') return { x: rect.x, y: rect.y - delta, width: rect.width, height: rect.height + delta }
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height + delta }
}

function roomOn(rect: Rect, edge: Edge, bounds: Rect): number {
  if (edge === 'left') return rect.x - bounds.x
  if (edge === 'right') return bounds.x + bounds.width - (rect.x + rect.width)
  if (edge === 'top') return rect.y - bounds.y
  return bounds.y + bounds.height - (rect.y + rect.height)
}

function canPlace(candidate: Rect, bounds: Rect, others: readonly Rect[]): boolean {
  if (!insideBounds(candidate, bounds)) return false
  return others.every((other) => !overlaps(candidate, other))
}

function maxGrow(rect: Rect, edge: Edge, bounds: Rect, others: readonly Rect[]): number {
  const room = Math.max(0, Math.round(roomOn(rect, edge, bounds)))
  if (room <= 0) return 0
  let best = 0
  let lo = 1
  let hi = room
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (canPlace(grown(rect, edge, mid), bounds, others)) {
      best = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return best
}

const EDGES: readonly Edge[] = ['left', 'right', 'top', 'bottom']

function expandOthers(items: LayoutItem[], movedId: string, bounds: Rect): void {
  const others = items.filter((item) => item.id !== movedId)
  for (let pass = 0; pass < 32; pass += 1) {
    let grew = false
    for (const item of others) {
      for (const edge of EDGES) {
        const obstacles = items.filter((other) => other.id !== item.id).map((other) => other.rect)
        const delta = maxGrow(item.rect, edge, bounds, obstacles)
        if (delta > 0) {
          item.rect = grown(item.rect, edge, delta)
          grew = true
        }
      }
    }
    if (!grew) return
  }
}

export function reflowNeighbors(input: {
  rects: Array<{ id: string; rect: Rect }>
  movedId: string
  nextRect: Rect
  bounds: Rect
  minWidth: number
  minHeight: number
}): Array<{ id: string; rect: Rect }> {
  const items: LayoutItem[] = input.rects.map((item) => ({
    id: item.id,
    rect: copyRect(item.rect)
  }))
  const moved = items.find((item) => item.id === input.movedId)
  if (!moved) return items

  const bounds = roundRect(input.bounds)
  const minWidth = Math.min(input.minWidth, bounds.width)
  const minHeight = Math.min(input.minHeight, bounds.height)
  moved.rect = clampRect(input.nextRect, bounds, input.minWidth, input.minHeight)

  for (const item of items) {
    if (item.id === moved.id) continue
    item.rect = roundRect(item.rect)
    resolveOverlap(moved.rect, item.rect, minWidth, minHeight)
  }

  expandOthers(items, moved.id, bounds)

  return items.map((item) => ({ id: item.id, rect: roundRect(item.rect) }))
}
