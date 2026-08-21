/**
 * Touch-scroll arithmetic for the phone terminal. It lives outside
 * `RemoteTerminal.tsx` because this is the logic the "scrolling the history is
 * impossible" complaint is really about, and `.tsx` cannot be tested in this
 * project (vitest runs in node, there is no DOM runner).
 *
 * Two decisions are encoded here. First, xterm scrolls in whole lines while a
 * finger moves in pixels: every helper threads a fractional `carry` instead of
 * rounding, so a slow, careful drag through the history still moves rather
 * than being swallowed line after line. Second, a lifted finger keeps going —
 * a phone without inertia feels broken — so the fling velocity is measured
 * over the tail of the drag only, which is what makes "stop, then lift" mean
 * stop.
 *
 * Sign convention throughout: positive means *toward newer output*, the same
 * direction `Terminal.scrollLines` uses.
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

/**
 * Total travel below this stays a tap and is left to xterm (selection, focus,
 * the long-press callout). Apple's own drag slop is in this range.
 */
export const DRAG_SLOP_PX = 8

/** Only the last stretch of a drag decides the fling — see the docblock. */
export const VELOCITY_WINDOW_MS = 90

/** A flick slower than this is a placement, not a throw; and it ends momentum. */
export const MIN_FLING_PX_PER_MS = 0.05

/** A bad timestamp pair must not launch the buffer into orbit. */
export const MAX_FLING_PX_PER_MS = 6

/** Momentum keeps this share of its speed per 60 Hz frame. */
export const FRICTION_PER_FRAME = 0.94

const FRAME_MS = 1000 / 60

/** A backgrounded tab returns with a huge delta; treat it as one frame. */
const MAX_STEP_MS = 50

/**
 * Convert a pixel delta into whole lines, carrying the remainder. Returns the
 * carry untouched for a cell height we do not trust (pre-layout, zero rows),
 * so nothing scrolls until xterm has measured itself.
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

/** Append a sample and drop everything older than the velocity window. */
export function pushSample(
  samples: readonly TouchSample[],
  sample: TouchSample
): readonly TouchSample[] {
  const kept = samples.filter((entry) => sample.t - entry.t <= VELOCITY_WINDOW_MS)
  return [...kept, sample]
}

/**
 * Scroll velocity (px/ms, positive = toward newer output) for a lifted finger,
 * or 0 when the gesture does not deserve momentum.
 */
export function flingVelocity(samples: readonly TouchSample[]): number {
  if (samples.length < 2) return 0
  const first = samples[0]
  const last = samples[samples.length - 1]
  const elapsed = last.t - first.t
  if (elapsed <= 0) return 0
  const velocity = -(last.y - first.y) / elapsed
  if (Math.abs(velocity) < MIN_FLING_PX_PER_MS) return 0
  return Math.max(-MAX_FLING_PX_PER_MS, Math.min(MAX_FLING_PX_PER_MS, velocity))
}

/** Exponential friction, framerate-independent so 120 Hz does not stop sooner. */
export function decayVelocity(velocity: number, elapsedMs: number): number {
  if (elapsedMs <= 0) return velocity
  return velocity * FRICTION_PER_FRAME ** (elapsedMs / FRAME_MS)
}

/** One animation frame of momentum: how far to scroll and what is left of it. */
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
 * Lines per page-up / page-down tap. Two rows of overlap: without them the
 * eye loses the place it was reading, which is the whole point of paging
 * rather than flicking.
 */
export function pageScrollLines(rows: number): number {
  if (!Number.isFinite(rows)) return 1
  return Math.max(1, Math.floor(rows) - 2)
}
