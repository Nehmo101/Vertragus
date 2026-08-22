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
