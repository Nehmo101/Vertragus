/**
 * Turning the xterm buffer into text worth pasting. A phone cannot select a
 * screenful of terminal by hand, so "copy the history" copies all of it — but
 * the buffer is a fixed grid: every unused row comes back as a run of spaces,
 * and the rows below the cursor come back blank. Pasting that into a chat is
 * pasting hundreds of empty lines.
 *
 * The grid is also the reason the *rows* are not the lines. A phone terminal
 * is ~38 columns wide, so an ordinary stack-trace line or a `git log
 * --oneline` entry occupies three or four rows, and xterm marks each
 * continuation `isWrapped`. Joining rows blindly is how a paste ends up broken
 * mid-word at column 38 — the wrap belongs to the phone that displayed it, not
 * to the text.
 */

/**
 * One row of the grid: its untrimmed contents, and whether it continues the
 * row above (xterm's `ILine.isWrapped`).
 */
export interface BufferRow {
  text: string
  wrapped: boolean
}

/**
 * Fold the grid's rows back into the logical lines the agent actually wrote.
 * Untrimmed text is expected: a row that is continued is full by definition,
 * and trimming it before the join would eat the spaces at the wrap point.
 *
 * A `wrapped` flag on the very first row has nothing to continue — the line it
 * belongs to was trimmed out of the scrollback — so it starts a line of its
 * own rather than being dropped.
 */
export function unwrapRows(rows: readonly BufferRow[]): string[] {
  const lines: string[] = []
  for (const row of rows) {
    if (row.wrapped && lines.length > 0) lines[lines.length - 1] += row.text
    else lines.push(row.text)
  }
  return lines
}

/**
 * Join buffer lines into a paste-ready block: trailing spaces off every line,
 * blank lines above and below the actual output dropped, blank lines *inside*
 * the output kept — they are the paragraph breaks of a terminal session.
 */
export function bufferPlainText(lines: readonly string[]): string {
  const trimmed = lines.map((line) => line.replace(/\s+$/, ''))
  let first = 0
  while (first < trimmed.length && trimmed[first] === '') first += 1
  let last = trimmed.length
  while (last > first && trimmed[last - 1] === '') last -= 1
  return trimmed.slice(first, last).join('\n')
}
