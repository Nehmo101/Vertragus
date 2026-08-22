/**
 * Screen zones — where the CLI windows of a role are allowed to live.
 *
 * A zone is stored RELATIVE to the work area of one display (0..1) plus that
 * display's id. Absolute pixel rects would silently mis-place every window as
 * soon as a monitor is unplugged, scaled or re-arranged; relative rects survive
 * a resolution change and degrade honestly (display gone → no zone → the
 * auto-tiling fallback takes over).
 *
 * Pure geometry, no Electron import, so the overlay editor and the placement
 * code can both use it and it stays unit-testable.
 */
import { z } from 'zod'

/** Zones smaller than this in either axis cannot hold a readable terminal. */
export const MIN_ZONE_FRACTION = 0.05
/** A profile with more than this many zones is a config error, not a layout. */
export const MAX_ZONES = 32

const fraction = z.number().min(0).max(1)

export const relRectSchema = z
  .object({
    x: fraction,
    y: fraction,
    w: z.number().min(MIN_ZONE_FRACTION).max(1),
    h: z.number().min(MIN_ZONE_FRACTION).max(1)
  })
  .strict()
export type RelRect = z.infer<typeof relRectSchema>

export const zoneSchema = z
  .object({
    roleId: z.string().trim().min(1).max(40),
    /** Electron `Display.id`. Not an index — indices shift when monitors change. */
    displayId: z.number().int(),
    rect: relRectSchema
  })
  .strict()
export type Zone = z.infer<typeof zoneSchema>

export const zoneLayoutSchema = z
  .object({
    zones: z.array(zoneSchema).max(MAX_ZONES).default([]),
    /**
     * Electron `Display.id` of the screen Vertragus windows live on.
     *
     * Drawn zones still pin themselves to a display, but auto-tiling and the
     * overlay editor need a single answer to "which monitor is this profile
     * on?" when several are attached. Absent = every attached display (the
     * historical auto-tile-across-all-monitors behaviour).
     */
    targetDisplayId: z.number().int().optional()
  })
  .strict()
export type ZoneLayout = z.infer<typeof zoneLayoutSchema>

export interface AbsRect {
  x: number
  y: number
  width: number
  height: number
}

export interface DisplayLike {
  id: number
  workArea: AbsRect
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * Absolute pixel rect of a zone on the display it was drawn on.
 *
 * Returns `null` when that display is not currently attached — the caller then
 * falls back to auto-tiling instead of placing a window at a guessed position
 * on the wrong monitor.
 */
export function resolveZoneRect(
  zone: Pick<Zone, 'displayId' | 'rect'>,
  displays: readonly DisplayLike[]
): AbsRect | null {
  // Prefer the stored Electron id. When it is gone, a single attached display
  // is still the monitor the zone was drawn on — Windows churns Display.id
  // across sessions/reboots even when the physical layout did not change, and
  // treating that as "unplugged" silently drops every hand-drawn zone into
  // auto-tiling.
  let display = displays.find((candidate) => candidate.id === zone.displayId)
  if (!display && displays.length === 1) display = displays[0]
  if (!display) return null
  const { workArea } = display
  const width = Math.round(clamp(zone.rect.w, 0, 1) * workArea.width)
  const height = Math.round(clamp(zone.rect.h, 0, 1) * workArea.height)
  const x = Math.round(workArea.x + clamp(zone.rect.x, 0, 1) * workArea.width)
  const y = Math.round(workArea.y + clamp(zone.rect.y, 0, 1) * workArea.height)
  // Keep the rect inside the work area even if x + w drifted past 1 while dragging.
  return {
    x: Math.min(x, workArea.x + workArea.width - width),
    y: Math.min(y, workArea.y + workArea.height - height),
    width,
    height
  }
}

/**
 * Inverse of {@link resolveZoneRect} for saving what the user just dragged.
 * The result is clamped into the unit square and to {@link MIN_ZONE_FRACTION},
 * so a sloppy drag can never persist a rect the schema would later reject.
 */
export function absToRelRect(rect: AbsRect, workArea: AbsRect): RelRect {
  if (workArea.width <= 0 || workArea.height <= 0) {
    return { x: 0, y: 0, w: MIN_ZONE_FRACTION, h: MIN_ZONE_FRACTION }
  }
  const w = clamp(rect.width / workArea.width, MIN_ZONE_FRACTION, 1)
  const h = clamp(rect.height / workArea.height, MIN_ZONE_FRACTION, 1)
  return {
    x: clamp((rect.x - workArea.x) / workArea.width, 0, 1 - w),
    y: clamp((rect.y - workArea.y) / workArea.height, 0, 1 - h),
    w,
    h
  }
}

/** All zones of one role, in layout order (several agents share a role zone). */
export function zonesForRole(layout: ZoneLayout | undefined, roleId: string): Zone[] {
  return (layout?.zones ?? []).filter((zone) => zone.roleId === roleId)
}
