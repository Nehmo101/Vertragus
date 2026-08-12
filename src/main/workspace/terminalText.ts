/**
 * Turning raw PTY scrollback into something a model can read.
 *
 * `read_output` is the orchestrator's only window into what an agent actually
 * did — and raw scrollback is useless for that: it is full of colour codes,
 * cursor moves and carriage-return redraws (spinners, progress bars, the
 * "thinking…" line every CLI paints). Handing that to a model wastes tokens and
 * hides the content.
 *
 * Full-screen TUIs (cursor-agent, codex) are the hard case: they paint the
 * alternate screen with cursor positioning and emit almost no `\n` at all, so
 * their vertical moves have to be read AS the line breaks they visually are —
 * otherwise the entire session is one line and the tail comes back empty.
 *
 * Control characters are built with fromCharCode so this file stays plain
 * ASCII — no invisible escape bytes committed into the repository.
 */

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)

/** CSI sequences: colours, cursor movement, erase — `ESC [ … final`. */
const CSI_PATTERN = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, 'g')
/**
 * Vertical cursor motion and screen clears — a full-screen TUI's substitute
 * for `\n`. CUP/HVP (`H`/`f`), up/down (`A`/`B`), next/prev line (`E`/`F`),
 * VPA (`d`), erase display (`J`), plus the bare `ESC D`/`E`/`M` index moves.
 * Stripping these silently (as CSI_PATTERN would) glues a whole alternate
 * screen session into ONE line, which the `\r` redraw logic then collapses to
 * nothing — that is how `read_output` on a cursor-agent came back empty.
 */
const CURSOR_BREAK_PATTERN = new RegExp(`${ESC}(?:\\[[0-9;]*[ABEFHJdf]|[DEM])`, 'g')
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

/**
 * Shared PTY chunk normalisation for `read_output` and the sentinel parser.
 *
 * Vertical cursor moves become `\n` first (so alternate-screen TUIs keep their
 * line structure), then ANSI/OSC/C0 junk is stripped. One function so the two
 * consumers cannot drift.
 *
 * For whole buffers (`terminalTail` / `read_output`) call this directly. For
 * incremental PTY reads, use {@link splitIncompleteAnsiTail} first so an escape
 * split across chunk boundaries is not half-eaten.
 */
export function normalizeTerminalChunk(value: string): string {
  return stripAnsi(value.replace(CURSOR_BREAK_PATTERN, '\n'))
}

/**
 * Split off a trailing incomplete ANSI/OSC escape so the next chunk can finish
 * it. Complete escapes (and text with no ESC) stay in `ready`.
 *
 * Without this, a lone ESC at a chunk boundary is stripped by CONTROL_PATTERN
 * and the remainder (`[0m…`) leaks into the payload as literal text.
 */
export function splitIncompleteAnsiTail(value: string): { ready: string; hold: string } {
  const lastEsc = value.lastIndexOf(ESC)
  if (lastEsc < 0) return { ready: value, hold: '' }
  const tail = value.slice(lastEsc)
  if (isCompleteEscapeFrom(tail)) return { ready: value, hold: '' }
  return { ready: value.slice(0, lastEsc), hold: tail }
}

/** True when `from` (starting at ESC) begins with a complete escape sequence. */
function isCompleteEscapeFrom(from: string): boolean {
  if (!from.startsWith(ESC) || from.length < 2) return false
  const second = from.charAt(1)
  // OSC: ESC ] … BEL | ESC \
  if (second === ']') {
    return from.includes(BEL) || from.includes(`${ESC}\\`)
  }
  // CSI: ESC [ params/intermediate final
  if (second === '[') {
    return new RegExp(`^${ESC}\\[[0-9;?]*[ -/]*[@-~]`).test(from)
  }
  // Two-character escapes (ESC D / ESC M / ESC = / …)
  return /[@-Z\\-_]/.test(second)
}

export const DEFAULT_MAX_LINE_LENGTH = 400

/**
 * The last `maxLines` meaningful lines of a scrollback.
 *
 * A carriage return rewrites its line, so only the text after the last `\r`
 * survives — that is what the user sees on screen, and it collapses a
 * thousand-frame spinner into one line.
 *
 * Vertical cursor moves count as line breaks (see CURSOR_BREAK_PATTERN), and
 * a repaint loop that re-draws the same text every tick is collapsed by
 * deduplicating consecutive identical lines — the tail should show what is on
 * screen once, not one copy per animation frame.
 */
export function terminalTail(
  buffer: string,
  maxLines: number,
  maxLineLength = DEFAULT_MAX_LINE_LENGTH
): string[] {
  const raw = normalizeTerminalChunk(buffer)
    .split('\n')
    .map((line) => line.slice(line.lastIndexOf('\r') + 1).trimEnd())
  const lines: string[] = []
  for (const line of raw) {
    if (lines.length > 0 && lines[lines.length - 1] === line) continue
    lines.push(line)
  }

  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  while (lines.length > 0 && lines[0] === '') lines.shift()

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
