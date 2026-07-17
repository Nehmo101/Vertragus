/**
 * Plain-text tail of a PTY scrollback for the canvas terminal peek:
 * strips ANSI escape sequences, resolves carriage-return progress lines
 * and returns the last N non-empty lines, each capped in length.
 *
 * Control characters are built via fromCharCode so this source file stays
 * plain ASCII (no invisible escape bytes in the repo).
 */

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)

const CSI_PATTERN = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, 'g')
const OSC_PATTERN = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)?`, 'g')
const ESC_SINGLE_PATTERN = new RegExp(`${ESC}[@-_]`, 'g')
/** Remaining C0 control chars except \n and \r, which the line logic needs. */
const CONTROL_PATTERN = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(8)}` +
    `${String.fromCharCode(11)}${String.fromCharCode(12)}` +
    `${String.fromCharCode(14)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
  'g'
)

export function stripAnsi(value: string): string {
  return value
    .replace(OSC_PATTERN, '')
    .replace(CSI_PATTERN, '')
    .replace(ESC_SINGLE_PATTERN, '')
    .replace(CONTROL_PATTERN, '')
}

export function terminalTail(buffer: string, maxLines: number, maxLineLength = 120): string[] {
  const lines = stripAnsi(buffer)
    .split('\n')
    // A carriage return rewrites the line (spinners, progress bars) — keep the final state.
    .map((line) => line.slice(line.lastIndexOf('\r') + 1).trimEnd())

  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

  return lines
    .slice(-Math.max(1, maxLines))
    .map((line) => (line.length > maxLineLength ? `${line.slice(0, maxLineLength - 1)}…` : line))
}
