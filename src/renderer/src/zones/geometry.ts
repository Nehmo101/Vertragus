/**
 * The zone editor's arithmetic, kept out of the components.
 *
 * The overlay window IS the display's work area, so a zone's CSS pixels and the
 * screen pixels it will later occupy are the same coordinate system minus the
 * work area's origin — which is exactly what `absToRelRect` expects when it is
 * handed an origin of (0,0). That is the whole conversion; everything else here
 * is clamping, so a drag can never produce a rect the schema would reject or
 * the user could lose off-screen.
 */
import { MIN_ZONE_FRACTION, absToRelRect, type RelRect, type Zone } from '@shared/schema/zones'

export interface PxRect {
  x: number
  y: number
  width: number
  height: number
}

export interface Viewport {
  width: number
  height: number
}

/** Never draw a zone smaller than this, whatever the monitor's size. */
export const MIN_ZONE_PX_WIDTH = 180
export const MIN_ZONE_PX_HEIGHT = 130

/** A new zone starts as a readable block, not a hairline. */
export const NEW_ZONE_FRACTION = 0.34
/** Each further new zone is offset by this, so they do not stack invisibly. */
export const NEW_ZONE_CASCADE = 28

export function minZoneSize(viewport: Viewport): { width: number; height: number } {
  return {
    width: Math.max(MIN_ZONE_PX_WIDTH, Math.round(viewport.width * MIN_ZONE_FRACTION)),
    height: Math.max(MIN_ZONE_PX_HEIGHT, Math.round(viewport.height * MIN_ZONE_FRACTION))
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Keep a rect fully inside the viewport without changing its size. */
export function clampMove(rect: PxRect, viewport: Viewport): PxRect {
  return {
    ...rect,
    x: Math.round(clamp(rect.x, 0, Math.max(0, viewport.width - rect.width))),
    y: Math.round(clamp(rect.y, 0, Math.max(0, viewport.height - rect.height)))
  }
}

/** Keep a resize above the minimum and inside the viewport (origin fixed). */
export function clampResize(rect: PxRect, viewport: Viewport): PxRect {
  const min = minZoneSize(viewport)
  const maxWidth = Math.max(min.width, viewport.width - rect.x)
  const maxHeight = Math.max(min.height, viewport.height - rect.y)
  return {
    ...rect,
    width: Math.round(clamp(rect.width, min.width, maxWidth)),
    height: Math.round(clamp(rect.height, min.height, maxHeight))
  }
}

/** Relative zone rect → pixels of this overlay. */
export function relToPx(rect: RelRect, viewport: Viewport): PxRect {
  return clampMove(
    clampResize(
      {
        x: Math.round(rect.x * viewport.width),
        y: Math.round(rect.y * viewport.height),
        width: Math.round(rect.w * viewport.width),
        height: Math.round(rect.h * viewport.height)
      },
      viewport
    ),
    viewport
  )
}

/** Pixels of this overlay → the relative rect that gets persisted. */
export function pxToRel(rect: PxRect, viewport: Viewport): RelRect {
  return absToRelRect(rect, { x: 0, y: 0, width: viewport.width, height: viewport.height })
}

export interface DraftZone {
  /** Local key; zones have no identity in the schema, only role + rect. */
  id: string
  roleId: string
  label: string
  color: string
  rect: PxRect
}

/** Where the nth new zone of this session is dropped. */
export function newZoneRect(viewport: Viewport, index: number): PxRect {
  const size = clampResize(
    {
      x: 0,
      y: 0,
      width: Math.round(viewport.width * NEW_ZONE_FRACTION),
      height: Math.round(viewport.height * NEW_ZONE_FRACTION)
    },
    viewport
  )
  const offset = (index % 6) * NEW_ZONE_CASCADE
  return clampMove(
    {
      ...size,
      x: Math.round(viewport.width * 0.08) + offset,
      y: Math.round(viewport.height * 0.14) + offset
    },
    viewport
  )
}

/** The drafts of this overlay as storable zones. */
export function draftsToZones(
  drafts: readonly DraftZone[],
  displayId: number,
  viewport: Viewport
): Zone[] {
  return drafts.map((draft) => ({
    roleId: draft.roleId,
    displayId,
    rect: pxToRel(draft.rect, viewport)
  }))
}
