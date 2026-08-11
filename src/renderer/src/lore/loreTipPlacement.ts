/**
 * Where a lore card goes, as arithmetic.
 *
 * Hovering a Commedia name — "Limbo", "Inferno", "Fortuna" — reveals a small
 * card that says what the place or the figure IS. The blurbs have been in
 * `@shared/lore` and `@shared/workspaceNames` since the names existed; what was
 * missing is the card, and the panel showed them as a native `title` tooltip
 * instead: half a second of nothing, then an OS rectangle in the OS font,
 * outside the glass, on top of an always-on-top window.
 *
 * The placement is the whole difficulty, and it is pure arithmetic, so it lives
 * here rather than in the component:
 *
 * - The card is `position: fixed`, because everything it could be anchored to
 *   (`.panel-scroll`, a workspace card) clips its own overflow — an absolutely
 *   positioned card inside them would be cut off at the first edge it reaches.
 * - A window is not a screen. The panel is ~280px wide and an Electron window
 *   clips at its own bounds, so a card that would hang over the edge is not
 *   "mostly visible", it is cut in half. Hence the clamping below, and hence a
 *   card that flips ABOVE its trigger when there is no room underneath.
 *
 * Everything here is in CSS pixels, in the hovered window's viewport.
 */

/** The rectangle of the element being hovered, as `getBoundingClientRect` gives it. */
export interface TriggerRect {
  left: number
  right: number
  top: number
  bottom: number
}

/** The viewport the card has to fit into — the WINDOW, not the screen. */
export interface Viewport {
  width: number
  height: number
}

export interface LoreTipPlacement {
  left: number
  top: number
  /** Card width in px; narrowed when the window is narrower than the card. */
  width: number
  /** True when the card had to flip above the trigger — the arrow follows. */
  above: boolean
}

/** Preferred card width; the panel is 280px, so this fills it with a margin. */
export const LORE_TIP_WIDTH = 236
/** Gap between the trigger and the card. */
export const LORE_TIP_GAP = 6
/** Never touch the window edge — the glass has a rounded border to respect. */
export const LORE_TIP_MARGIN = 8
/**
 * Assumed card height for the flip decision. The card is measured AFTER it
 * renders, but the first frame has to be placed already; two lines of blurb
 * plus the name is the honest average, and a card that ends up taller still
 * gets clamped into the window by the top/bottom rules below.
 */
export const LORE_TIP_ESTIMATED_HEIGHT = 76

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  return Math.min(max, Math.max(min, value))
}

/**
 * Place the card under (or over) its trigger, inside the window.
 *
 * `height` is the measured card height once there is one; without it the
 * estimate above decides the flip. Left-aligned to the trigger because the
 * names are left-aligned too — a centred card under a left-aligned name reads
 * as belonging to whatever sits to its right.
 */
export function loreTipPlacement(
  trigger: TriggerRect,
  viewport: Viewport,
  height: number = LORE_TIP_ESTIMATED_HEIGHT
): LoreTipPlacement {
  const width = Math.min(LORE_TIP_WIDTH, Math.max(0, viewport.width - 2 * LORE_TIP_MARGIN))
  const left = clamp(trigger.left, LORE_TIP_MARGIN, viewport.width - width - LORE_TIP_MARGIN)

  const below = trigger.bottom + LORE_TIP_GAP
  const roomBelow = viewport.height - below - LORE_TIP_MARGIN
  const roomAbove = trigger.top - LORE_TIP_GAP - LORE_TIP_MARGIN
  // Flip only when above is genuinely better: a card that jumps sides on a
  // two-pixel difference is worse than one that is a little tight.
  const above = roomBelow < height && roomAbove > roomBelow

  const top = above
    ? clamp(trigger.top - LORE_TIP_GAP - height, LORE_TIP_MARGIN, Math.max(LORE_TIP_MARGIN, viewport.height - height - LORE_TIP_MARGIN))
    : clamp(below, LORE_TIP_MARGIN, Math.max(LORE_TIP_MARGIN, viewport.height - height - LORE_TIP_MARGIN))

  return { left, top, width, above }
}

/**
 * How long the pointer must rest on a name before its card appears.
 *
 * Long enough that sweeping the mouse down a list of agents does not strobe
 * five cards, short enough to feel like an answer rather than a wait. Closing
 * is immediate — a card that lingers is a card in the way.
 */
export const LORE_TIP_OPEN_DELAY_MS = 320
