/**
 * Turning raw PTY scrollback into something a model can read.
 *
 * `read_output` is the orchestrator's only window into what an agent actually
 * did — and raw scrollback is useless for that: it is full of colour codes,
 * cursor moves and carriage-return redraws (spinners, progress bars, the
 * "thinking…" line every CLI paints). Handing that to a model wastes tokens and
 * hides the content.
 *
 * Control characters are built with fromCharCode so this file stays plain
 * ASCII — no invisible escape bytes committed into the repository.
 */

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)

/** CSI sequences: colours, cursor movement, erase — `ESC [ … final`. */
const CSI_PATTERN = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, 'g')
/** OSC sequences: window titles, hyperlinks — `ESC ] … BEL|ESC \\`. */
const OSC_PATTERN = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)?`, 'g')
/** Two-character escapes such as `ESC =` / `ESC >` (keypad modes). */
const ESC_SINGLE_PATTERN = new RegExp(`${ESC}[@-_]`, 'g')
/** Remaining C0 controls except \n and \r, which the line logic still needs. */
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

export const DEFAULT_MAX_LINE_LENGTH = 400

/**
 * The last `maxLines` meaningful lines of a scrollback.
 *
 * A carriage return rewrites its line, so only the text after the last `\r`
 * survives — that is what the user sees on screen, and it collapses a
 * thousand-frame spinner into one line.
 */
export function terminalTail(
  buffer: string,
  maxLines: number,
  maxLineLength = DEFAULT_MAX_LINE_LENGTH
): string[] {
  const lines = stripAnsi(buffer)
    .split('\n')
    .map((line) => line.slice(line.lastIndexOf('\r') + 1).trimEnd())

  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

  return lines
    .slice(-Math.max(1, maxLines))
    .map((line) => (line.length > maxLineLength ? `${line.slice(0, maxLineLength - 1)}…` : line))
}

/** {@link terminalTail} as one block of text — the shape `read_output` returns. */
export function terminalTailText(
  buffer: string,
  maxLines: number,
  maxLineLength = DEFAULT_MAX_LINE_LENGTH
): string {
  return terminalTail(buffer, maxLines, maxLineLength).join('\n')
}
