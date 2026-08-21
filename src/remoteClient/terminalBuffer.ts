/**
 * Turning the xterm buffer into text worth pasting. A phone cannot select a
 * screenful of terminal by hand, so "copy the history" copies all of it — but
 * the buffer is a fixed grid: every unused row comes back as a run of spaces,
 * and the rows below the cursor come back blank. Pasting that into a chat is
 * pasting hundreds of empty lines.
 */

/**
 * Join buffer rows into a paste-ready block: trailing spaces off every row,
 * blank rows above and below the actual output dropped, blank rows *inside*
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
