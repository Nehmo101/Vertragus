/**
 * Deterministic auto-layout for the zone overlay: one rectangle per palette
 * role, gapless and non-overlapping, always above `minZoneSize`.
 */
import type { ZoneEditorRole } from '../../../preload'
import { minZoneSize, type DraftZone, type PxRect, type Viewport } from './geometry'

/** Left-column share for the orchestrator when three or more roles are laid out. */
const ORCHESTRATOR_FRACTION = 0.38

/**
 * Split `total` into `count` positive integer parts that sum exactly to `total`.
 * The last part absorbs the rounding remainder.
 */
function splitEqual(total: number, count: number): number[] {
  if (count <= 0) return []
  if (count === 1) return [total]
  const base = Math.floor(total / count)
  const parts = Array.from({ length: count }, () => base)
  parts[count - 1] = total - base * (count - 1)
  return parts
}

/** Side-by-side columns that fill the viewport. */
function splitVertical(count: number, viewport: Viewport): PxRect[] {
  const widths = splitEqual(viewport.width, count)
  let x = 0
  return widths.map((width) => {
    const rect = { x, y: 0, width, height: viewport.height }
    x += width
    return rect
  })
}

/**
 * Choose a column count that keeps every equal cell at or above `min`.
 * Starts at `ceil(sqrt(count))` and shrinks until it fits (or a single column).
 */
function chooseColumns(
  count: number,
  area: Viewport,
  min: { width: number; height: number }
): number {
  let cols = Math.max(1, Math.ceil(Math.sqrt(count)))
  while (cols > 1) {
    const rows = Math.ceil(count / cols)
    if (area.width / cols >= min.width && area.height / rows >= min.height) break
    cols -= 1
  }
  return cols
}

/**
 * Pack `count` cells into `area`, origin at `(offsetX, 0)`.
 * The last row may have fewer cells — those cells share the full width so no
 * gap remains. Every size comes from `splitEqual`, so the union fills `area`.
 */
function layoutGrid(
  count: number,
  area: Viewport,
  offsetX: number,
  min: { width: number; height: number }
): PxRect[] {
  const cols = chooseColumns(count, area, min)
  const rows = Math.ceil(count / cols)
  const rowHeights = splitEqual(area.height, rows)
  const rects: PxRect[] = []
  let y = 0
  let index = 0

  for (let row = 0; row < rows; row++) {
    const height = rowHeights[row]!
    const cellsInRow = row === rows - 1 ? count - index : Math.min(cols, count - index)
    const colWidths = splitEqual(area.width, cellsInRow)
    let x = offsetX

    for (let col = 0; col < cellsInRow; col++) {
      const width = colWidths[col]!
      rects.push({ x, y, width, height })
      x += width
      index += 1
    }
    y += height
  }

  return rects
}

/**
 * One pixel rect per role, in palette order (orchestrator first).
 * Empty input → empty output. Results are safe for `pxToRel` / the zone schema.
 */
export function autoLayoutRects(
  roles: readonly ZoneEditorRole[],
  viewport: Viewport
): PxRect[] {
  const n = roles.length
  if (n === 0) return []
  if (n === 1) {
    return [{ x: 0, y: 0, width: viewport.width, height: viewport.height }]
  }
  if (n === 2) {
    return splitVertical(2, viewport)
  }

  const min = minZoneSize(viewport)
  let orchWidth = Math.round(viewport.width * ORCHESTRATOR_FRACTION)
  orchWidth = Math.max(min.width, orchWidth)
  orchWidth = Math.min(orchWidth, viewport.width - min.width)

  const rest: Viewport = {
    width: viewport.width - orchWidth,
    height: viewport.height
  }
  const orch: PxRect = { x: 0, y: 0, width: orchWidth, height: viewport.height }
  return [orch, ...layoutGrid(n - 1, rest, orchWidth, min)]
}

/** Draft zones (without local ids) for every palette role. */
export function autoLayoutDrafts(
  roles: readonly ZoneEditorRole[],
  viewport: Viewport
): Array<Omit<DraftZone, 'id'>> {
  const rects = autoLayoutRects(roles, viewport)
  return roles.map((role, index) => ({
    roleId: role.roleId,
    label: role.label,
    color: role.color,
    rect: rects[index]!
  }))
}
