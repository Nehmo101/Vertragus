/**
 * Touch-scroll arithmetic for the phone and laptop terminal. It lives outside
 * `RemoteTerminal.tsx` because this is the logic the "scrolling the history is
 * impossible" complaint is really about, and `.tsx` cannot be tested in this
 * project (vitest runs in node, there is no DOM runner).
 *
 * The previous scroller quantized a finger into whole xterm lines and carried
 * the remainder. That is why a slow drag felt dead: nothing moved until the
 * carry filled one cell (~20 px), and xterm's own viewport — which already
 * maps `.xterm-viewport.scrollTop` onto `ydisp` at pixel resolution — was
 * never asked. The drag now owns the pixel position itself; xterm is told
 * only the whole-row origin, and `.xterm-screen` is translated by the
 * remainder. Reading the DOM `scrollTop` back as source of truth lost every
 * sub-line pixel to xterm's rAF snap (`scrollTop = ydisp * cellHeight`).
 *
 * A lifted finger keeps going — a phone without inertia feels broken — so the
 * fling velocity is measured over the tail of the drag only, which is what
 * makes "stop, then lift" mean stop. Momentum writes the same `scrollTop`.
 *
 * Sign convention throughout: positive means *toward newer output*, the same
 * direction `Terminal.scrollLines` and a growing `scrollTop` use.
 */

/** One line-quantised scroll step plus the pixels that did not fit into it. */
export interface LineStep {
  lines: number
  carry: number
}

/** One finger position: viewport y in px, event timestamp in ms. */
export interface TouchSample {
  y: number
  t: number
}

/** The result of writing a pixel delta onto a viewport's `scrollTop`. */
export interface ScrollPosition {
  scrollTop: number
  moved: boolean
}

/**
 * Total travel below this stays a tap and is left to xterm (selection, focus,
 * the long-press callout). Apple's own drag slop is in this range. Once the
 * gesture commits, this distance is applied, not discarded — the slop is a
 * discriminator, not a tax.
 */
export const DRAG_SLOP_PX = 8

/** Only the last stretch of a drag decides the fling — see the docblock. */
export const VELOCITY_WINDOW_MS = 160

/** A flick slower than this is a placement, not a throw; and it ends momentum. */
export const MIN_FLING_PX_PER_MS = 0.02

/**
 * A finger that has come to rest in this tail is a placement, even when the
 * longer velocity window still holds samples from the motion before the stop.
 */
const SETTLE_MS = 40
const SETTLE_PX = 2

/** A bad timestamp pair must not launch the buffer into orbit. */
export const MAX_FLING_PX_PER_MS = 6

/** Momentum keeps this share of its speed per 60 Hz frame. */
export const FRICTION_PER_FRAME = 0.94

const FRAME_MS = 1000 / 60

/** A backgrounded tab returns with a huge delta; treat it as one frame. */
const MAX_STEP_MS = 50

/** Wheel `deltaMode === 1` (lines) uses this when the cell height is unknown. */
const FALLBACK_LINE_PX = 16

/**
 * Convert a pixel delta into whole lines, carrying the remainder. Returns the
 * carry untouched for a cell height we do not trust (pre-layout, zero rows),
 * so nothing scrolls until xterm has measured itself.
 *
 * Kept for the page-up / page-down buttons, which still speak lines. The
 * finger and the wheel no longer go through here.
 */
export function linesFromPixels(deltaPx: number, cellHeight: number, carry: number): LineStep {
  if (!Number.isFinite(cellHeight) || cellHeight <= 0 || !Number.isFinite(deltaPx)) {
    return { lines: 0, carry }
  }
  const total = carry + deltaPx
  const lines = Math.trunc(total / cellHeight)
  return { lines, carry: total - lines * cellHeight }
}

/** Has this gesture committed to scrolling? `travelPx` is summed, not net. */
export function isDrag(travelPx: number): boolean {
  return travelPx >= DRAG_SLOP_PX
}

/**
 * Pixel delta to apply for this move once the gesture is a drag.
 *
 * `appliedY` is the last `clientY` already written into scrollTop. Before the
 * first committed move it is `null`, and the delta is measured from `originY`
 * so the slop pixels ride along instead of being thrown away.
 *
 * Returns `null` while travel is still a tap.
 */
export function committedFingerDelta(
  originY: number,
  appliedY: number | null,
  currentY: number,
  travelPx: number
): number | null {
  if (!isDrag(travelPx)) return null
  if (!Number.isFinite(originY) || !Number.isFinite(currentY)) return null
  const from = appliedY === null || !Number.isFinite(appliedY) ? originY : appliedY
  return currentY - from
}

/** What a drag needs to know about the buffer under it before it takes over. */
export interface ScrollableBuffer {
  /** The alternate screen is in use — a full-screen TUI is drawing. */
  alternate: boolean
  /** `IBuffer.baseY`: how many lines of history sit above the viewport. */
  baseY: number
}

/**
 * Is there any history for a drag to move? A drag that takes the gesture and
 * then finds nothing to scroll is worse than one that never took it: the
 * `preventDefault()` is already spent, so the screen sits completely inert
 * under the finger and the app reads as hung.
 *
 * Two buffers have nowhere to go. The alternate screen is exactly one screen
 * with no scrollback at all (`ydisp === ybase === 0` always), which is what a
 * full-screen TUI runs in; and a fresh session has not filled a screen yet.
 * In both, the gesture is worth more left to the browser and to xterm's own
 * selection than swallowed here.
 */
export function bufferCanScroll(buffer: ScrollableBuffer): boolean {
  if (buffer.alternate) return false
  return Number.isFinite(buffer.baseY) && buffer.baseY > 0
}

/**
 * The DOM half of the same question: has the viewport actually grown past one
 * screen? Used together with {@link bufferCanScroll} so a buffer that has
 * history but a viewport that has not been measured yet is still claimed, and
 * a measured overflow is claimed even if `baseY` has not caught up to a write.
 */
export function viewportCanScroll(port: { scrollHeight: number; clientHeight: number }): boolean {
  if (!Number.isFinite(port.scrollHeight) || !Number.isFinite(port.clientHeight)) return false
  return port.scrollHeight > port.clientHeight + 0.5
}

/** How far `scrollTop` may go on this viewport. */
export function maxScrollTop(scrollHeight: number, clientHeight: number): number {
  if (!Number.isFinite(scrollHeight) || !Number.isFinite(clientHeight)) return 0
  return Math.max(0, scrollHeight - clientHeight)
}

/** Clamp a proposed `scrollTop` onto `[0, max]`. */
export function clampScrollTop(scrollTop: number, max: number): number {
  if (!Number.isFinite(scrollTop)) return 0
  if (!Number.isFinite(max) || max <= 0) return 0
  return Math.min(max, Math.max(0, scrollTop))
}

/**
 * Finger motion onto `scrollTop`. A finger moving down (positive `clientYDelta`)
 * drags older output into view, which is a *smaller* `scrollTop` — the same
 * sign xterm's `handleTouchMove` uses (`lastY - currentY`).
 */
export function applyFingerDelta(
  scrollTop: number,
  clientYDelta: number,
  max: number
): ScrollPosition {
  if (!Number.isFinite(clientYDelta) || clientYDelta === 0) {
    const held = clampScrollTop(scrollTop, max)
    return { scrollTop: held, moved: held !== scrollTop }
  }
  const next = clampScrollTop(scrollTop - clientYDelta, max)
  return { scrollTop: next, moved: next !== scrollTop }
}

/**
 * Wheel / trackpad motion onto `scrollTop`. Positive `deltaY` is "down" in
 * every engine, which is toward newer output, which is a larger `scrollTop`.
 */
export function applyWheelDelta(scrollTop: number, deltaY: number, max: number): ScrollPosition {
  if (!Number.isFinite(deltaY) || deltaY === 0) {
    const held = clampScrollTop(scrollTop, max)
    return { scrollTop: held, moved: held !== scrollTop }
  }
  const next = clampScrollTop(scrollTop + deltaY, max)
  return { scrollTop: next, moved: next !== scrollTop }
}

/**
 * Normalise a `wheel` event to CSS pixels. `deltaMode` is 0 (pixels, trackpads
 * and most mice), 1 (lines, older mice) or 2 (pages). Ctrl-wheel is the
 * browser's own zoom and is not a scroll — the caller must ignore it.
 */
export function wheelDeltaPx(
  event: { deltaY: number; deltaMode: number },
  lineHeight: number
): number {
  if (!Number.isFinite(event.deltaY)) return 0
  if (event.deltaMode === 1) {
    const line = Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : FALLBACK_LINE_PX
    return event.deltaY * line
  }
  if (event.deltaMode === 2) {
    return event.deltaY * (lineHeight > 0 ? lineHeight * 24 : 600)
  }
  return event.deltaY
}

/** Append a sample and drop everything older than the velocity window. */
export function pushSample(
  samples: readonly TouchSample[],
  sample: TouchSample
): readonly TouchSample[] {
  const kept = samples.filter((entry) => sample.t - entry.t <= VELOCITY_WINDOW_MS)
  return [...kept, sample]
}

/**
 * True when the tail of the drag has come to rest — a placement, not a throw.
 * The longer velocity window would otherwise keep a flick's samples alive
 * through a pause and launch the buffer after the reader had already stopped.
 */
export function fingerHasSettled(samples: readonly TouchSample[]): boolean {
  if (samples.length < 2) return true
  const last = samples[samples.length - 1]
  const settleFrom = last.t - SETTLE_MS
  let origin = samples[0]
  for (const sample of samples) {
    if (sample.t <= settleFrom) origin = sample
    else break
  }
  if (last.t - origin.t < SETTLE_MS / 2) return false
  return Math.abs(last.y - origin.y) <= SETTLE_PX
}

/**
 * Scroll velocity (px/ms, positive = toward newer output) for a lifted finger,
 * or 0 when the gesture does not deserve momentum.
 *
 * The window is long enough that a flick which slowed in the last samples
 * still has its moving stretch. A finger that then came to rest is filtered
 * out by {@link fingerHasSettled} so "stop, then lift" still means stop.
 */
export function flingVelocity(samples: readonly TouchSample[]): number {
  if (samples.length < 2) return 0
  const first = samples[0]
  const last = samples[samples.length - 1]
  const elapsed = last.t - first.t
  if (elapsed <= 0) return 0
  if (fingerHasSettled(samples)) return 0
  const velocity = -(last.y - first.y) / elapsed
  if (Math.abs(velocity) < MIN_FLING_PX_PER_MS) return 0
  return Math.max(-MAX_FLING_PX_PER_MS, Math.min(MAX_FLING_PX_PER_MS, velocity))
}

/** Exponential friction, framerate-independent so 120 Hz does not stop sooner. */
export function decayVelocity(velocity: number, elapsedMs: number): number {
  if (elapsedMs <= 0) return velocity
  return velocity * FRICTION_PER_FRAME ** (elapsedMs / FRAME_MS)
}

/** One animation frame of line-quantised momentum — used by tests of decay. */
export function momentumStep(
  velocity: number,
  elapsedMs: number,
  cellHeight: number,
  carry: number
): LineStep & { velocity: number } {
  const step = Math.min(Math.max(elapsedMs, 0), MAX_STEP_MS)
  const moved = linesFromPixels(velocity * step, cellHeight, carry)
  const next = decayVelocity(velocity, step)
  return {
    lines: moved.lines,
    carry: moved.carry,
    velocity: Math.abs(next) < MIN_FLING_PX_PER_MS ? 0 : next
  }
}

/**
 * One animation frame of pixel momentum: the next `scrollTop` and what is
 * left of the fling. Hitting either end kills the glide instead of oscillating.
 */
export function momentumStepPixels(
  velocity: number,
  elapsedMs: number,
  scrollTop: number,
  max: number
): ScrollPosition & { velocity: number } {
  const step = Math.min(Math.max(elapsedMs, 0), MAX_STEP_MS)
  const next = applyWheelDelta(scrollTop, velocity * step, max)
  const decayed = decayVelocity(velocity, step)
  return {
    scrollTop: next.scrollTop,
    moved: next.moved,
    velocity: !next.moved || Math.abs(decayed) < MIN_FLING_PX_PER_MS ? 0 : decayed
  }
}

/**
 * Width at or below which the terminal chrome folds (pager hidden, keys
 * closed). Coarse pointers fold at any width; a laptop window this narrow is
 * a phone for layout purposes even if the pointer is still fine — DevTools
 * device mode is exactly that, and so is a split laptop window.
 */
export const COMPACT_MAX_WIDTH_PX = 700

/**
 * Extra rows xterm paints below the clip so a sub-row `translateY` can reveal
 * the next line instead of a blank band. Local only: the host still hears the
 * fitted visible size (`hostResize` uses `proposeDimensions`, not this).
 */
export const OVERSCAN_ROWS = 1

/** Visible rows plus the local overscan. */
export function overscanRowCount(visibleRows: number): number {
  if (!Number.isFinite(visibleRows) || visibleRows < 1) return 1
  return Math.floor(visibleRows) + OVERSCAN_ROWS
}

/** Should the reading chrome (pager, open keys) fold away? */
export function isCompactChrome(input: { coarse: boolean; widthPx: number }): boolean {
  if (input.coarse) return true
  return Number.isFinite(input.widthPx) && input.widthPx <= COMPACT_MAX_WIDTH_PX
}

/**
 * Lines per page-up / page-down tap. Two rows of overlap: without them the
 * eye loses the place it was reading, which is the whole point of paging
 * rather than flicking.
 */
export function pageScrollLines(rows: number): number {
  if (!Number.isFinite(rows)) return 1
  return Math.max(1, Math.floor(rows) - 2)
}

/**
 * Split a pixel `scrollTop` into the line-aligned value xterm will keep and
 * the sub-row remainder a CSS `translateY` has to carry.
 *
 * xterm's viewport listener sets `ydisp = round(scrollTop / cellHeight)` and
 * then `_innerRefresh` writes `scrollTop` back to `ydisp * cellHeight`. A
 * caller that treats the DOM `scrollTop` as source of truth therefore loses
 * every sub-line pixel on the next frame — which is why a slow drag still
 * felt dead after the third-pass 1:1 write. The drag keeps the real position
 * itself; it writes `lineTop` so `round(scrollTop / cell)` equals
 * `floor(desired / cell)` (no mid-cell jump), and shifts `.xterm-screen` by
 * `-remainderPx` so the paint follows the finger inside the cell.
 */
export interface SubrowPan {
  lineTop: number
  remainderPx: number
}

export function splitScrollPx(scrollTop: number, cellHeight: number): SubrowPan {
  if (!Number.isFinite(scrollTop)) return { lineTop: 0, remainderPx: 0 }
  if (!Number.isFinite(cellHeight) || cellHeight <= 0) {
    return { lineTop: scrollTop, remainderPx: 0 }
  }
  const remainderPx = ((scrollTop % cellHeight) + cellHeight) % cellHeight
  return { lineTop: scrollTop - remainderPx, remainderPx }
}

/** CSS transform that paints `remainderPx` of the next row. `'none'` at rest. */
export function subrowTransform(remainderPx: number): string {
  if (!Number.isFinite(remainderPx) || remainderPx === 0) return 'none'
  return `translateY(${-remainderPx}px)`
}
