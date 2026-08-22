/**
 * Where the panel goes — pure logic, no Electron.
 *
 * The panel docks to a screen edge. What survives a restart is the stored
 * {@link PanelBounds}: which edge, and how far down. The x coordinate is
 * always re-derived from the edge and the current work area, so a display
 * that shrank or moved can never strand the panel off-screen; y is clamped
 * into the work area for the same reason.
 */
import type { PanelBounds } from '@main/store/settings'

export const PANEL_WIDTH = 280
export const PANEL_MAX_HEIGHT = 680
export const PANEL_MARGIN = 12

export interface WorkArea {
  x: number
  y: number
  width: number
  height: number
}

export interface PanelPlacement {
  x: number
  y: number
  height: number
}

/** Initial window geometry: stored bounds when present, right-center otherwise. */
export function panelPlacement(bounds: PanelBounds | undefined, workArea: WorkArea): PanelPlacement {
  const height = Math.min(PANEL_MAX_HEIGHT, workArea.height - PANEL_MARGIN * 2)
  const edge = bounds?.edge ?? 'right'
  const x =
    edge === 'left'
      ? workArea.x + PANEL_MARGIN
      : workArea.x + workArea.width - PANEL_WIDTH - PANEL_MARGIN
  const centered = workArea.y + Math.round((workArea.height - height) / 2)
  const y =
    bounds === undefined
      ? centered
      : Math.min(Math.max(bounds.y, workArea.y), workArea.y + Math.max(0, workArea.height - height))
  return { x, y, height }
}

/** What to persist after the user dropped the panel at (x, y). */
export function panelBoundsFromPosition(x: number, y: number, workArea: WorkArea): PanelBounds {
  const panelCenter = x + PANEL_WIDTH / 2
  const areaCenter = workArea.x + workArea.width / 2
  return { edge: panelCenter < areaCenter ? 'left' : 'right', y }
}
