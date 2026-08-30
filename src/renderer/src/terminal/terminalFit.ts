/**
 * When the desktop CLI should resize the PTY.
 *
 * `FitAddon.fit()` returns *silently* when the view is not laid out yet, so
 * wrapping it in try/catch cannot tell a real size from xterm's constructor
 * default (80×24). The caller has to ask `proposeDimensions()` first and stop
 * when that is undefined — the same rule as the remote client's
 * `terminalResize.ts`, kept here so the desktop renderer never imports that
 * module (phone transients and A+/A− do not apply to a real window).
 */

export interface TerminalFitSize {
  cols: number
  rows: number
}

/** The size to send to the PTY, or undefined to leave it alone. */
export function ptyFitSize(
  fitted: TerminalFitSize | undefined,
  sent?: TerminalFitSize
): TerminalFitSize | undefined {
  if (!fitted) return undefined
  if (!Number.isFinite(fitted.cols) || !Number.isFinite(fitted.rows)) return undefined
  const cols = Math.floor(fitted.cols)
  const rows = Math.floor(fitted.rows)
  if (cols < 1 || rows < 1) return undefined
  if (sent && sent.cols === cols && sent.rows === rows) return undefined
  return { cols, rows }
}
