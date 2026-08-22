/**
 * When the phone is allowed to reshape the agent's terminal.
 *
 * The PTY behind this view is not the phone's. It is the same PTY the desktop
 * window is attached to, and `resize` is a real `SIGWINCH`: the agent's TUI
 * repaints at whatever this client asks for, on the desktop user's screen too.
 * That makes a resize an expensive, shared act — and most of what moves this
 * phone's geometry is neither expensive nor shared: a software keyboard taking
 * half the viewport, a rotation, an A+/A− tap.
 *
 * Four rules, in order:
 *
 *  1. No proposal, no resize. `FitAddon.fit()` returns *silently* when the
 *     view is not laid out yet, so the caller cannot learn that from a throw;
 *     it has to ask `proposeDimensions()` and stop when the answer is
 *     undefined. Without this the first pass sends xterm's untouched 80×24.
 *  2. A viewport too small to be a terminal is a transient, not a size. An
 *     opening keyboard leaves ~12 rows for a moment, and a shared PTY driven
 *     to 12 rows is an agent's TUI destroyed on both screens.
 *  3. A local readability change never reaches the host. A+/A− is a zoom of
 *     *this* screen; the session's shape is not the phone's to rewrite because
 *     someone wanted bigger glyphs. The cost is that the host keeps wrapping
 *     at the width the last real viewport change asked for — a slightly early
 *     wrap, which is the mild direction — and it self-corrects at the next
 *     rotation, keyboard close or re-attach.
 *  4. A size the host already has is not news. Every fit used to send one, so
 *     a keyboard opening and closing was two `SIGWINCH`es for no change.
 */

export interface TerminalSize {
  cols: number
  rows: number
}

/** Below this a phone terminal is a transient, not a size worth sharing. */
export const MIN_HOST_COLS = 20
export const MIN_HOST_ROWS = 10

export interface ResizeInput {
  /** What `FitAddon.proposeDimensions()` answered; undefined = not laid out. */
  fitted: TerminalSize | undefined
  /** The size this client last sent, or undefined if it never has. */
  sent: TerminalSize | undefined
  /**
   * The fit was triggered by a local readability change (the font control)
   * rather than by the viewport actually changing shape.
   */
  local: boolean
  /** A software keyboard or similar overlay is occupying the viewport. */
  transient: boolean
}

/** The size to send to the host, or undefined to leave the PTY alone. */
export function hostResize(input: ResizeInput): TerminalSize | undefined {
  const fitted = input.fitted
  if (!fitted) return undefined
  if (!Number.isFinite(fitted.cols) || !Number.isFinite(fitted.rows)) return undefined
  if (fitted.cols < MIN_HOST_COLS || fitted.rows < MIN_HOST_ROWS) return undefined
  if (input.local || input.transient) return undefined
  if (input.sent && input.sent.cols === fitted.cols && input.sent.rows === fitted.rows) {
    return undefined
  }
  return { cols: fitted.cols, rows: fitted.rows }
}

/**
 * How much of the viewport an overlay has to take before it reads as a
 * software keyboard rather than as this screen's shape. The smallest phone
 * keyboard is around 260 CSS px; browser chrome collapsing and expanding is
 * under 100, and a rubber-band scroll less again. The gap between them is
 * wide, so the threshold sits in the gap rather than at 1 px.
 */
export const KEYBOARD_MIN_PX = 120

export interface TransientInput {
  /**
   * A coarse pointer. Nothing else has a software keyboard, and a laptop
   * window being dragged smaller means exactly what it says.
   */
  coarse: boolean
  /** One of this view's own fields — the composer, the search bar — has focus. */
  ownField: boolean
  /**
   * How far the visible viewport is displaced inside the layout viewport, in
   * CSS pixels: `viewportDisplacementPx`, which counts an iOS shrink and an
   * iOS shift alike.
   */
  displacement: number
}

/**
 * Is the fit this viewport is producing a transient — a keyboard's doing
 * rather than the screen's?
 *
 * The measured half is the load-bearing one, and it is measured rather than
 * inferred on purpose. `inputmode="none"` keeps the on-screen keyboard off
 * xterm's hidden textarea, but WebKit has only honoured that attribute since
 * Safari 16.4: on an older iOS a tap on the *output* still raises the
 * keyboard, and a keyboard raised that way sets none of this view's own flags.
 * The ~12-row fit that follows clears `MIN_HOST_ROWS`, so with nothing but the
 * flags the shared PTY takes a 12-row `SIGWINCH` and the agent's TUI repaints
 * on the desktop user's screen — the exact failure `inputmode` was added to
 * stop, reached by the one route `inputmode` does not close.
 *
 * The `ownField` half stays because it is true *earlier*: focus lands before
 * the viewport has moved, and the first fit after it would otherwise go out.
 * It is also the only signal Android gives, where
 * `interactive-widget=resizes-content` shrinks the layout viewport together
 * with the visible one and leaves the displacement at zero — and where nothing
 * but our own fields raises a keyboard anyway, `inputmode` having been honoured
 * there since Chrome 66.
 */
export function isTransientViewport(input: TransientInput): boolean {
  if (!input.coarse) return false
  return input.ownField || input.displacement >= KEYBOARD_MIN_PX
}
