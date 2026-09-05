import { describe, expect, it } from 'vitest'
import {
  colorCss,
  countMatches,
  findRow,
  followState,
  isPlainRun,
  liveRange,
  noteTouches,
  paletteRgb,
  renderPlan,
  rowRuns,
  rowSignature,
  rowText,
  runPresentation,
  scrollbackPatch,
  SETTLE_MS,
  ScrollbackSync,
  type CellReader,
  type LineReader,
  type RunColor,
  type ScrollbackMarker,
  type ScrollbackParser
} from './terminalRows'

interface FakeCell {
  chars?: string
  width?: number
  fg?: RunColor
  bg?: RunColor
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  inverse?: boolean
  invisible?: boolean
}

function cell(spec: FakeCell): CellReader {
  const fg = spec.fg ?? null
  const bg = spec.bg ?? null
  return {
    getChars: () => spec.chars ?? '',
    getWidth: () => spec.width ?? 1,
    getFgColor: () => (fg === null ? 0 : fg.kind === 'palette' ? fg.index : fg.value),
    getBgColor: () => (bg === null ? 0 : bg.kind === 'palette' ? bg.index : bg.value),
    isFgDefault: () => fg === null,
    isFgPalette: () => fg?.kind === 'palette',
    isFgRGB: () => fg?.kind === 'rgb',
    isBgDefault: () => bg === null,
    isBgPalette: () => bg?.kind === 'palette',
    isBgRGB: () => bg?.kind === 'rgb',
    isBold: () => (spec.bold ? 1 : 0),
    isDim: () => (spec.dim ? 1 : 0),
    isItalic: () => (spec.italic ? 1 : 0),
    isUnderline: () => (spec.underline ? 1 : 0),
    isInverse: () => (spec.inverse ? 1 : 0),
    isInvisible: () => (spec.invisible ? 1 : 0),
    isStrikethrough: () => (spec.strike ? 1 : 0)
  }
}

function line(cells: FakeCell[]): LineReader {
  return {
    length: cells.length,
    getCell: (x) => (x < cells.length ? cell(cells[x]!) : undefined)
  }
}

/** Plain text, one cell per character. */
function plain(text: string, style: Omit<FakeCell, 'chars'> = {}): FakeCell[] {
  return [...text].map((chars) => ({ ...style, chars }))
}

describe('rowRuns', () => {
  it('folds cells that share a style into one run', () => {
    const runs = rowRuns(line(plain('hello')), 80)
    expect(runs).toHaveLength(1)
    expect(runs[0]!.text).toBe('hello')
    expect(isPlainRun(runs[0]!)).toBe(true)
  })

  it('starts a new run where the style changes', () => {
    const red: RunColor = { kind: 'palette', index: 1 }
    const runs = rowRuns(line([...plain('ok '), ...plain('FAIL', { fg: red, bold: true })]), 80)
    expect(runs.map((run) => run.text)).toEqual(['ok ', 'FAIL'])
    expect(runs[1]!.fg).toEqual(red)
    expect(runs[1]!.bold).toBe(true)
  })

  it('trims trailing blank cells but keeps the gaps between words', () => {
    const cells = [...plain('a  b'), ...plain('   ')]
    expect(rowText(rowRuns(line(cells), 80))).toBe('a  b')
  })

  it('keeps trailing spaces that carry a background', () => {
    const cells = [...plain('x'), ...plain('  ', { bg: { kind: 'palette', index: 4 } })]
    expect(rowText(rowRuns(line(cells), 80))).toBe('x  ')
  })

  it('reads an empty row as no runs', () => {
    expect(rowRuns(line(plain('     ')), 80)).toEqual([])
    expect(rowRuns(undefined, 80)).toEqual([])
  })

  it('skips the continuation cell of a wide glyph', () => {
    const cells: FakeCell[] = [{ chars: '漢', width: 2 }, { chars: '', width: 0 }, { chars: '字', width: 2 }, { chars: '', width: 0 }]
    expect(rowText(rowRuns(line(cells), 80))).toBe('漢字')
  })

  it('renders an empty or invisible cell as a space inside the row', () => {
    const cells: FakeCell[] = [{ chars: 'a' }, { chars: '' }, { chars: 'b', invisible: true }, { chars: 'c' }]
    expect(rowText(rowRuns(line(cells), 80))).toBe('a  c')
  })

  it('gives the cursor cell a run of its own, even on an empty cell', () => {
    const runs = rowRuns(line(plain('ab')), 80, 1)
    expect(runs.map((run) => [run.text, run.cursor])).toEqual([
      ['a', false],
      ['b', true]
    ])
    const past = rowRuns(line([...plain('ab'), { chars: '' }]), 80, 2)
    expect(past[past.length - 1]).toMatchObject({ text: ' ', cursor: true })
  })

  it('draws a wrap-pending cursor past the last column after trimming', () => {
    const runs = rowRuns(line(plain('abc')), 3, 3)
    expect(runs.map((run) => [run.text, run.cursor])).toEqual([
      ['abc', false],
      [' ', true]
    ])
  })

  it('never reads past the column count it was given', () => {
    expect(rowText(rowRuns(line(plain('abcdef')), 3))).toBe('abc')
    expect(rowText(rowRuns(line(plain('ab')), 0))).toBe('')
  })

  it('folds true colour like it folds the palette, and splits where the value changes', () => {
    const teal: RunColor = { kind: 'rgb', value: 0x2f7d6d }
    const rust: RunColor = { kind: 'rgb', value: 0x9c4221 }
    const runs = rowRuns(line([...plain('ok', { fg: teal }), ...plain('!!', { fg: rust })]), 80)
    expect(runs.map((run) => run.text)).toEqual(['ok', '!!'])
    expect(runs[0]!.fg).toEqual(teal)
    expect(runs[1]!.fg).toEqual(rust)
  })

  it('never folds a palette run into a true-colour run carrying the same number', () => {
    // Colour 3 of the palette and #000003 are different colours, and only the
    // kind separates them: comparing the numbers alone would paint the second
    // half of the row in the first half's colour.
    const runs = rowRuns(
      line([
        ...plain('a', { fg: { kind: 'palette', index: 3 } }),
        ...plain('b', { fg: { kind: 'rgb', value: 3 } })
      ]),
      80
    )
    expect(runs.map((run) => run.text)).toEqual(['a', 'b'])
    expect(runs[0]!.fg).toEqual({ kind: 'palette', index: 3 })
    expect(runs[1]!.fg).toEqual({ kind: 'rgb', value: 3 })
  })

  it('reads a palette index outside the 256 as the default colour', () => {
    // A cell claiming palette 300 would otherwise reach the sheet as a
    // `fg-300` class that names nothing, or an inline colour computed from an
    // index the cube has no entry for.
    const runs = rowRuns(line(plain('x', { fg: { kind: 'palette', index: 300 } })), 80)
    expect(runs[0]!.fg).toBeNull()
    expect(isPlainRun(runs[0]!)).toBe(true)
  })

  it('reads nothing when the column count is not a finite number', () => {
    expect(rowRuns(line(plain('abc')), Number.NaN)).toEqual([])
    expect(rowRuns(line(plain('abc')), Number.POSITIVE_INFINITY)).toEqual([])
  })

  it('stops at the first cell the line will not hand over', () => {
    // A line reports its length up front but can refuse a cell (the buffer was
    // trimmed under the read). What came before the hole still paints; the
    // reader does not walk on over undefined cells.
    const holed: LineReader = {
      length: 5,
      getCell: (x) => (x < 2 ? cell({ chars: 'ab'[x]! }) : undefined)
    }
    expect(rowText(rowRuns(holed, 80))).toBe('ab')
  })
})

describe('row signature', () => {
  it('changes exactly when the painted row would', () => {
    const a = rowSignature(rowRuns(line(plain('abc')), 80))
    const b = rowSignature(rowRuns(line(plain('abc')), 80))
    expect(a).toBe(b)
    expect(rowSignature(rowRuns(line(plain('abd')), 80))).not.toBe(a)
    expect(rowSignature(rowRuns(line(plain('abc', { bold: true })), 80))).not.toBe(a)
    expect(rowSignature(rowRuns(line(plain('abc')), 80, 1))).not.toBe(a)
  })

  it('separates every attribute, not only the bold one', () => {
    // The live region is repainted per row by comparing signatures. An
    // attribute missing from the key is a row that keeps its old paint when
    // the parser switches to it.
    const attributes: ReadonlyArray<Omit<FakeCell, 'chars'>> = [
      {},
      { bold: true },
      { dim: true },
      { italic: true },
      { underline: true },
      { strike: true },
      { inverse: true }
    ]
    const signatures = attributes.map((style) =>
      rowSignature(rowRuns(line(plain('abc', style)), 80))
    )
    expect(new Set(signatures).size).toBe(attributes.length)
  })

  it('separates a palette colour from a true colour with the same number', () => {
    const paletteRow = rowSignature(
      rowRuns(line(plain('a', { fg: { kind: 'palette', index: 9 } })), 80)
    )
    const trueColourRow = rowSignature(
      rowRuns(line(plain('a', { fg: { kind: 'rgb', value: 9 } })), 80)
    )
    expect(paletteRow).not.toBe(trueColourRow)
  })
})

describe('colours', () => {
  it('maps the 6x6x6 cube and the grey ramp like every terminal does', () => {
    expect(paletteRgb(16)).toBe('#000000')
    expect(paletteRgb(21)).toBe('#0000ff')
    expect(paletteRgb(231)).toBe('#ffffff')
    expect(paletteRgb(232)).toBe('#080808')
    expect(paletteRgb(255)).toBe('#eeeeee')
    expect(paletteRgb(15)).toBe('')
  })

  it('leaves the 16 named colours to the sheet and paints the rest inline', () => {
    expect(colorCss({ kind: 'palette', index: 3 })).toBeNull()
    expect(colorCss({ kind: 'palette', index: 196 })).toBe('#ff0000')
    expect(colorCss({ kind: 'rgb', value: 0x12abef })).toBe('#12abef')
    expect(colorCss(null)).toBeNull()
  })

  it('names the palette and the attributes as classes', () => {
    const shown = runPresentation({
      fg: { kind: 'palette', index: 2 },
      bg: { kind: 'palette', index: 9 },
      bold: true,
      dim: false,
      italic: true,
      underline: true,
      strike: false,
      inverse: false,
      cursor: true
    })
    expect(shown.className).toBe('fg-2 bg-9 b i u cur')
    expect(shown.color).toBeNull()
    expect(shown.background).toBeNull()
  })

  it('swaps the halves for inverse video and lets the sheet fill the defaults', () => {
    const shown = runPresentation({
      fg: { kind: 'palette', index: 4 },
      bg: null,
      bold: false,
      dim: false,
      italic: false,
      underline: false,
      strike: false,
      inverse: true
    })
    expect(shown.className).toBe('inv bg-4')
    const rgb = runPresentation({
      fg: null,
      bg: { kind: 'rgb', value: 0x336699 },
      bold: false,
      dim: false,
      italic: false,
      underline: false,
      strike: false,
      inverse: true
    })
    expect(rgb.className).toBe('inv')
    expect(rgb.color).toBe('#336699')
    expect(rgb.background).toBeNull()
  })

  it('names dim and strike as classes too', () => {
    const shown = runPresentation({
      fg: null,
      bg: null,
      bold: false,
      dim: true,
      italic: false,
      underline: false,
      strike: true,
      inverse: false
    })
    expect(shown.className).toBe('d s')
    expect(shown.color).toBeNull()
    expect(shown.background).toBeNull()
  })
})

describe('scrollbackPatch', () => {
  it('appends only the lines that entered the scrollback', () => {
    expect(scrollbackPatch({ synced: 10, domCount: 10, base: 13, keep: 10 })).toEqual({
      dropHead: 0,
      appendFrom: 10
    })
  })

  it('drops from the head once the scrollback is full', () => {
    // 5000 rows on screen, 5000 in the buffer, marker moved down 7 lines: the
    // buffer stays at 5000, the oldest 7 rows are gone.
    expect(scrollbackPatch({ synced: 5000, domCount: 5000, base: 5000, keep: 4993 })).toEqual({
      dropHead: 7,
      appendFrom: 4993
    })
  })

  it('rebuilds everything after a burst longer than the scrollback', () => {
    // Marker trimmed away (keep 0): nothing on screen is still in the buffer.
    expect(scrollbackPatch({ synced: 5000, domCount: 5000, base: 5000, keep: 0 })).toEqual({
      dropHead: 5000,
      appendFrom: 0
    })
  })

  it('empties the DOM when a sequence cleared the scrollback', () => {
    // ED 3 disposes the marker and baseY is back at 0.
    expect(scrollbackPatch({ synced: 120, domCount: 120, base: 0, keep: 0 })).toEqual({
      dropHead: 120,
      appendFrom: 0
    })
  })

  it('rebuilds when the DOM is not level with the parser', () => {
    expect(scrollbackPatch({ synced: 40, domCount: 12, base: 40, keep: 12 })).toEqual({
      dropHead: 12,
      appendFrom: 0
    })
    expect(scrollbackPatch({ synced: 0, domCount: 0, base: 30, keep: 0 })).toEqual({
      dropHead: 0,
      appendFrom: 0
    })
  })

  it('does nothing when the marker still covers the whole DOM', () => {
    expect(scrollbackPatch({ synced: 8, domCount: 8, base: 8, keep: 8 })).toEqual({
      dropHead: 0,
      appendFrom: 8
    })
  })
})

class FakeMarker implements ScrollbackMarker {
  isDisposed = false
  constructor(public line: number) {}
  dispose(): void {
    this.isDisposed = true
    this.line = -1
  }
}

class FakeParser implements ScrollbackParser {
  base = 0
  cursorY = 0
  lastOffset: number | undefined
  nextMarker: FakeMarker | undefined
  get buffer() {
    return {
      active: { baseY: this.base, cursorY: this.cursorY },
      normal: { baseY: this.base }
    }
  }
  registerMarker(offset = 0): FakeMarker | undefined {
    this.lastOffset = offset
    if (this.nextMarker !== undefined) return this.nextMarker
    return new FakeMarker(this.base + this.cursorY + offset)
  }
}

describe('ScrollbackSync', () => {
  it('registers a marker on the last scrollback line relative to the cursor', () => {
    const parser = new FakeParser()
    parser.base = 10
    parser.cursorY = 3
    const sync = new ScrollbackSync(parser)
    sync.mark(10)
    expect(parser.lastOffset).toBe((10 - 1) - (10 + 3))
    expect(sync.next(10)).toEqual({ dropHead: 0, appendFrom: 10 })
  })

  it('drops the head when the marker moves down', () => {
    const parser = new FakeParser()
    parser.base = 50
    const marker = new FakeMarker(49)
    parser.nextMarker = marker
    const sync = new ScrollbackSync(parser)
    sync.mark(50)
    marker.line = 42
    expect(sync.next(50)).toEqual({ dropHead: 7, appendFrom: 43 })
  })

  it('drops everything when the marker is disposed', () => {
    const parser = new FakeParser()
    parser.base = 50
    const marker = new FakeMarker(49)
    parser.nextMarker = marker
    const sync = new ScrollbackSync(parser)
    sync.mark(50)
    parser.base = 0
    marker.dispose()
    expect(sync.next(50)).toEqual({ dropHead: 50, appendFrom: 0 })
  })

  it('rebuilds from 0 and disposes the marker', () => {
    const parser = new FakeParser()
    parser.base = 10
    const marker = new FakeMarker(9)
    parser.nextMarker = marker
    const sync = new ScrollbackSync(parser)
    sync.mark(10)
    expect(sync.next(10, true)).toEqual({ dropHead: 10, appendFrom: 0 })
    expect(marker.isDisposed).toBe(true)
  })
})

describe('renderPlan', () => {
  it('holds a rebuild until the normal buffer is on screen', () => {
    const whileAlt = renderPlan({ rebuild: true, rebuildLive: false }, true)
    expect(whileAlt).toEqual({
      scrollback: 'skip',
      live: 'rebuild',
      next: { rebuild: true, rebuildLive: false }
    })
    const back = renderPlan(whileAlt.next, false)
    expect(back.scrollback).toBe('rebuild')
    expect(back.live).toBe('rebuild')
    expect(back.next.rebuild).toBe(false)
    const after = renderPlan(back.next, false)
    expect(after.scrollback).toBe('patch')
    expect(after.live).toBe('patch')
  })
})

describe('gesture snap', () => {
  it('settles after 120 ms', () => {
    expect(SETTLE_MS).toBe(120)
  })

  it('starts settling only when the last finger lifts', () => {
    expect(noteTouches(false, 1)).toEqual({ touchDown: true, lifted: false })
    expect(noteTouches(true, 1)).toEqual({ touchDown: true, lifted: false })
    expect(noteTouches(true, 0)).toEqual({ touchDown: false, lifted: true })
    expect(noteTouches(false, 0)).toEqual({ touchDown: false, lifted: false })
  })
})

describe('liveRange', () => {
  it('is the last rows of the buffer', () => {
    expect(liveRange({ baseY: 100, length: 124 }, 24)).toEqual({ from: 100, to: 124 })
  })

  it('never runs past the buffer or below zero', () => {
    expect(liveRange({ baseY: 0, length: 10 }, 24)).toEqual({ from: 0, to: 10 })
    expect(liveRange({ baseY: -3, length: 10 }, 24)).toEqual({ from: 0, to: 10 })
  })
})

describe('followState', () => {
  it('follows at the bottom and within one row of it', () => {
    expect(followState({ scrollTop: 1000, scrollHeight: 1600, clientHeight: 600, rowHeight: 20 })).toBe(true)
    expect(followState({ scrollTop: 985, scrollHeight: 1600, clientHeight: 600, rowHeight: 20 })).toBe(true)
  })

  it('is paused further up', () => {
    expect(followState({ scrollTop: 900, scrollHeight: 1600, clientHeight: 600, rowHeight: 20 })).toBe(false)
  })

  it('follows a scroller that has nothing to scroll', () => {
    expect(followState({ scrollTop: 0, scrollHeight: 300, clientHeight: 600, rowHeight: 20 })).toBe(true)
  })

  it('gives no row of slack while the row height is still unmeasured', () => {
    // Before the reader has measured a row the height arrives as 0, NaN or a
    // negative from a hidden element. The one pixel of rounding tolerance
    // stays; the row of slack is not invented out of a bad measurement.
    expect(followState({ scrollTop: 999, scrollHeight: 1600, clientHeight: 600, rowHeight: 0 })).toBe(true)
    expect(followState({ scrollTop: 998, scrollHeight: 1600, clientHeight: 600, rowHeight: 0 })).toBe(false)
    expect(followState({ scrollTop: 998, scrollHeight: 1600, clientHeight: 600, rowHeight: Number.NaN })).toBe(false)
    expect(followState({ scrollTop: 985, scrollHeight: 1600, clientHeight: 600, rowHeight: -20 })).toBe(false)
  })
})

describe('search over rows', () => {
  const texts = ['alpha', 'beta', 'Gamma', 'delta', 'gamma ray']

  it('finds the next and previous matching row, case-insensitively', () => {
    expect(findRow(texts, 'gamma', -1, 'next')).toBe(2)
    expect(findRow(texts, 'gamma', 2, 'next')).toBe(4)
    expect(findRow(texts, 'gamma', 4, 'prev')).toBe(2)
  })

  it('wraps at both ends', () => {
    expect(findRow(texts, 'gamma', 4, 'next')).toBe(2)
    expect(findRow(texts, 'gamma', 2, 'prev')).toBe(4)
  })

  it('revisits the current row only after a full wrap', () => {
    expect(findRow(texts, 'alpha', 0, 'next')).toBe(0)
  })

  it('answers -1 for no match or an empty query', () => {
    expect(findRow(texts, 'zeta', -1, 'next')).toBe(-1)
    expect(findRow(texts, '   ', -1, 'next')).toBe(-1)
    expect(findRow([], 'a', -1, 'next')).toBe(-1)
  })

  it('counts matching rows', () => {
    expect(countMatches(texts, 'gamma')).toBe(2)
    expect(countMatches(texts, '')).toBe(0)
  })

  it('searches from the top when the highlighted row is not one of these rows', () => {
    // `from` is the row the view last highlighted; the list under it can be
    // rebuilt shorter or replaced between two taps of the search arrow. An
    // index the list no longer has must start a fresh sweep, not skip rows.
    expect(findRow(texts, 'gamma', 99, 'next')).toBe(2)
    expect(findRow(texts, 'gamma', -7, 'next')).toBe(2)
    expect(findRow(texts, 'gamma', 1.5, 'next')).toBe(2)
    expect(findRow(texts, 'gamma', 99, 'prev')).toBe(findRow(texts, 'gamma', -1, 'prev'))
  })
})
