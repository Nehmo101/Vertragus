/**
 * The reader's arithmetic: how one buffer line becomes styled runs, how the
 * scrollback DOM keeps step with the parser, and when the view counts as
 * following the newest output.
 *
 * The phone no longer puts xterm's renderer on the screen. A headless parser
 * holds the buffer at the PTY's own size, and the screen shows its rows as
 * plain text in a native scroller (`TerminalReader.tsx`). Everything that can
 * be decided without a DOM is decided here, so it runs under vitest in Node —
 * this project has no DOM runner, and logic left in a component is untested by
 * construction.
 *
 * Three facts about xterm's buffer shape the module:
 *
 *  - Lines below `baseY` are the scrollback. The phone never resizes the
 *    parser once a snapshot has sized it, so those lines never reflow, and the
 *    DOM for them is append-only ({@link scrollbackPatch}).
 *  - The parser fires `onScroll` once per line that enters the scrollback,
 *    and once with `0` when a sequence clears it. Counting those events between
 *    two renders is enough to know which lines are new — the clear case falls
 *    out of the same arithmetic because `baseY` is then `0`.
 *  - A wide glyph occupies two cells: the first carries the characters and a
 *    width of 2, the second is a width-0 continuation and is skipped.
 */

/**
 * The cell facts the reader needs — a structural subset of xterm's
 * `IBufferCell`, so tests can pass a plain object.
 */
export interface CellReader {
  getChars(): string
  getWidth(): number
  getFgColor(): number
  getBgColor(): number
  isFgDefault(): boolean
  isFgPalette(): boolean
  isFgRGB(): boolean
  isBgDefault(): boolean
  isBgPalette(): boolean
  isBgRGB(): boolean
  isBold(): number
  isDim(): number
  isItalic(): number
  isUnderline(): number
  isInverse(): number
  isInvisible(): number
  isStrikethrough(): number
}

/** The line facts the reader needs — a structural subset of `IBufferLine`. */
export interface LineReader {
  readonly length: number
  getCell(x: number, cell?: CellReader): CellReader | undefined
}

/** A colour as the parser reports it; `null` is the terminal default. */
export type RunColor = { kind: 'palette'; index: number } | { kind: 'rgb'; value: number } | null

export interface RunStyle {
  fg: RunColor
  bg: RunColor
  bold: boolean
  dim: boolean
  italic: boolean
  underline: boolean
  strike: boolean
  /** Foreground and background swapped, defaults included. */
  inverse: boolean
}

/** One stretch of a row that shares a style. */
export interface RowRun extends RunStyle {
  text: string
  /** The cell under the cursor — always a run of its own. */
  cursor: boolean
}

const DEFAULT_STYLE: RunStyle = {
  fg: null,
  bg: null,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  strike: false,
  inverse: false
}

function colorOf(
  cell: CellReader,
  which: 'fg' | 'bg'
): RunColor {
  const isDefault = which === 'fg' ? cell.isFgDefault() : cell.isBgDefault()
  if (isDefault) return null
  const value = which === 'fg' ? cell.getFgColor() : cell.getBgColor()
  const isRGB = which === 'fg' ? cell.isFgRGB() : cell.isBgRGB()
  if (isRGB) return { kind: 'rgb', value }
  const isPalette = which === 'fg' ? cell.isFgPalette() : cell.isBgPalette()
  if (isPalette && Number.isInteger(value) && value >= 0 && value < 256) {
    return { kind: 'palette', index: value }
  }
  return null
}

function styleOf(cell: CellReader): RunStyle {
  return {
    fg: colorOf(cell, 'fg'),
    bg: colorOf(cell, 'bg'),
    bold: cell.isBold() !== 0,
    dim: cell.isDim() !== 0,
    italic: cell.isItalic() !== 0,
    underline: cell.isUnderline() !== 0,
    strike: cell.isStrikethrough() !== 0,
    inverse: cell.isInverse() !== 0
  }
}

function sameColor(a: RunColor, b: RunColor): boolean {
  if (a === null || b === null) return a === b
  if (a.kind !== b.kind) return false
  return a.kind === 'palette' ? a.index === (b as { index: number }).index : a.value === (b as { value: number }).value
}

export function sameStyle(a: RunStyle, b: RunStyle): boolean {
  return (
    sameColor(a.fg, b.fg) &&
    sameColor(a.bg, b.bg) &&
    a.bold === b.bold &&
    a.dim === b.dim &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.strike === b.strike &&
    a.inverse === b.inverse
  )
}

export function isDefaultStyle(style: RunStyle): boolean {
  return sameStyle(style, DEFAULT_STYLE)
}

/**
 * A run that paints nothing: default style, only spaces, not the cursor. Such
 * runs are trimmed from the END of a row so a 200-column PTY line does not
 * wrap two hundred spaces on a 40-column phone. Inside a row they stay — they
 * are the gaps between words.
 */
function isBlankRun(run: RowRun): boolean {
  if (run.cursor) return false
  if (!isDefaultStyle(run)) return false
  return /^ *$/.test(run.text)
}

/**
 * Fold one buffer line into styled runs.
 *
 * `cursorX` is the column of the cursor when the cursor is on this row, or
 * `-1`. The cell under it becomes a run of its own, so a cursor glyph can be
 * drawn without disturbing the neighbours; an empty cell under the cursor is
 * rendered as a space so the glyph has a width.
 *
 * `scratch` is the reusable cell xterm's `getNullCell()` hands out. Passing it
 * saves one allocation per cell over a 5000-line snapshot; the tests omit it.
 */
export function rowRuns(
  line: LineReader | undefined,
  cols: number,
  cursorX = -1,
  scratch?: CellReader
): RowRun[] {
  const runs: RowRun[] = []
  if (!line) return runs
  const width = Math.min(Number.isFinite(cols) ? Math.max(0, Math.floor(cols)) : 0, line.length)
  for (let x = 0; x < width; x += 1) {
    const cell = line.getCell(x, scratch)
    if (!cell) break
    // A width-0 cell is the second half of a wide glyph that the cell before
    // it already carries.
    if (cell.getWidth() === 0) continue
    const cursor = x === cursorX
    let text = cell.getChars()
    if (text === '' || cell.isInvisible() !== 0) text = ' '
    const style = styleOf(cell)
    const last = runs[runs.length - 1]
    if (last && !cursor && !last.cursor && sameStyle(last, style)) {
      last.text += text
    } else {
      runs.push({ ...style, text, cursor })
    }
  }
  trimTrailingBlank(runs)
  return runs
}

/**
 * Strip the blank tail: whole runs that paint nothing, then the trailing
 * spaces of a default-styled last run that also carries words.
 */
function trimTrailingBlank(runs: RowRun[]): void {
  while (runs.length > 0 && isBlankRun(runs[runs.length - 1]!)) runs.pop()
  const last = runs[runs.length - 1]
  if (last && !last.cursor && isDefaultStyle(last)) {
    last.text = last.text.replace(/ +$/, '')
  }
}

/** The row's text, as a search over the history sees it. */
export function rowText(runs: readonly RowRun[]): string {
  let text = ''
  for (const run of runs) text += run.text
  return text
}

/**
 * A string that changes exactly when the painted row would. The live region
 * is re-rendered on every write; comparing signatures is what keeps that to
 * the rows a write actually touched.
 */
export function rowSignature(runs: readonly RowRun[]): string {
  let signature = ''
  for (const run of runs) {
    signature += `${styleKey(run)}${run.cursor ? 'C' : ''}${run.text}`
  }
  return signature
}

function colorKey(color: RunColor): string {
  if (color === null) return ''
  return color.kind === 'palette' ? `p${color.index}` : `r${color.value}`
}

function styleKey(style: RunStyle): string {
  return (
    colorKey(style.fg) +
    '/' +
    colorKey(style.bg) +
    (style.bold ? 'b' : '') +
    (style.dim ? 'd' : '') +
    (style.italic ? 'i' : '') +
    (style.underline ? 'u' : '') +
    (style.strike ? 's' : '') +
    (style.inverse ? 'v' : '')
  )
}

/** `#rrggbb` for one of xterm's 256 palette entries above the 16 named ones. */
export function paletteRgb(index: number): string {
  if (!Number.isInteger(index) || index < 16 || index > 255) return ''
  if (index >= 232) {
    const grey = 8 + (index - 232) * 10
    return hex(grey, grey, grey)
  }
  const cube = index - 16
  const level = (n: number): number => (n === 0 ? 0 : 55 + n * 40)
  return hex(level(Math.floor(cube / 36)), level(Math.floor(cube / 6) % 6), level(cube % 6))
}

function hex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((part) => part.toString(16).padStart(2, '0')).join('')}`
}

/** CSS colour for a run colour that cannot be a class, or `null`. */
export function colorCss(color: RunColor): string | null {
  if (color === null) return null
  if (color.kind === 'rgb') {
    const value = color.value & 0xffffff
    return hex((value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff)
  }
  return color.index < 16 ? null : paletteRgb(color.index)
}

/**
 * How a run is painted: a class list for the 16 named colours and the
 * attributes, inline colours for the 240 others and for true colour.
 *
 * Inverse video is resolved here rather than in the sheet: the foreground
 * colour lands on the background and vice versa, and the `inv` class supplies
 * the two defaults for whichever half the cell did not name.
 */
export interface RunPresentation {
  className: string
  color: string | null
  background: string | null
}

export function runPresentation(run: RunStyle & { cursor?: boolean }): RunPresentation {
  const classes: string[] = []
  const fg = run.inverse ? run.bg : run.fg
  const bg = run.inverse ? run.fg : run.bg
  if (run.inverse) classes.push('inv')
  if (fg?.kind === 'palette' && fg.index < 16) classes.push(`fg-${fg.index}`)
  if (bg?.kind === 'palette' && bg.index < 16) classes.push(`bg-${bg.index}`)
  if (run.bold) classes.push('b')
  if (run.dim) classes.push('d')
  if (run.italic) classes.push('i')
  if (run.underline) classes.push('u')
  if (run.strike) classes.push('s')
  if (run.cursor) classes.push('cur')
  return {
    className: classes.join(' '),
    color: colorCss(fg),
    background: colorCss(bg)
  }
}

/** True when the run needs no element of its own — plain text will do. */
export function isPlainRun(run: RowRun): boolean {
  return !run.cursor && isDefaultStyle(run)
}

/**
 * ## Keeping the scrollback DOM in step with the parser
 *
 * `synced` is the `baseY` the DOM was last brought level with, `domCount` how
 * many scrollback rows it holds, `base` the parser's `baseY` now, `scrolled`
 * how many `onScroll` events arrived since the last render.
 *
 * The rows kept are the ones that are still in the buffer: `base - scrolled`
 * of the old scrollback survived (the rest were trimmed off the head when the
 * scrollback was full), and the lines `[keep, base)` are the new ones to
 * append. A DOM that is not level with `synced` — a resize, a reset, a first
 * render — is rebuilt from line 0.
 */
export interface ScrollbackPatch {
  /** Rows to remove from the head of the DOM. */
  dropHead: number
  /** First buffer line to append; append every line up to `base`. */
  appendFrom: number
}

export function scrollbackPatch(input: {
  synced: number
  domCount: number
  base: number
  scrolled: number
}): ScrollbackPatch {
  const base = Math.max(0, input.base)
  if (input.domCount !== input.synced || input.domCount < 0) {
    return { dropHead: Math.max(0, input.domCount), appendFrom: 0 }
  }
  const keep = Math.max(0, Math.min(input.domCount, base - Math.max(0, input.scrolled)))
  return { dropHead: input.domCount - keep, appendFrom: keep }
}

/** The lines the screen shows live: the last `rows` of the buffer. */
export function liveRange(
  buffer: { baseY: number; length: number },
  rows: number
): { from: number; to: number } {
  const from = Math.max(0, buffer.baseY)
  const to = Math.max(from, Math.min(buffer.length, from + Math.max(0, rows)))
  return { from, to }
}

/**
 * Is the reader at the newest output? Within one row of the bottom counts:
 * a view parked a few pixels above the end is a reader who wants to follow,
 * not one who has scrolled up.
 */
export function followState(input: {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  rowHeight: number
}): boolean {
  const slack = Number.isFinite(input.rowHeight) && input.rowHeight > 0 ? input.rowHeight : 0
  const remaining = input.scrollHeight - input.scrollTop - input.clientHeight
  return !Number.isFinite(remaining) || remaining <= slack + 1
}

/**
 * Search over row texts, case-insensitive, wrapping at either end. `from` is
 * the row currently highlighted or `-1`; the row at `from` itself is only
 * revisited after a full wrap.
 */
export function findRow(
  texts: readonly string[],
  query: string,
  from: number,
  direction: 'next' | 'prev'
): number {
  const needle = query.trim().toLowerCase()
  if (needle === '' || texts.length === 0) return -1
  const count = texts.length
  const start = Number.isInteger(from) && from >= -1 && from < count ? from : -1
  const step = direction === 'next' ? 1 : -1
  for (let offset = 1; offset <= count; offset += 1) {
    const index = (((start + step * offset) % count) + count) % count
    if (texts[index]!.toLowerCase().includes(needle)) return index
  }
  return -1
}

/** How many rows contain the query. */
export function countMatches(texts: readonly string[], query: string): number {
  const needle = query.trim().toLowerCase()
  if (needle === '') return 0
  let count = 0
  for (const text of texts) if (text.toLowerCase().includes(needle)) count += 1
  return count
}
