import { describe, expect, it } from 'vitest'
import {
  colorCss,
  countMatches,
  findRow,
  followState,
  isPlainRun,
  liveRange,
  paletteRgb,
  rowRuns,
  rowSignature,
  rowText,
  runPresentation,
  scrollbackPatch,
  type CellReader,
  type LineReader,
  type RunColor
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

  it('never reads past the column count it was given', () => {
    expect(rowText(rowRuns(line(plain('abcdef')), 3))).toBe('abc')
    expect(rowText(rowRuns(line(plain('ab')), 0))).toBe('')
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
})

describe('scrollbackPatch', () => {
  it('appends only the lines that entered the scrollback', () => {
    expect(scrollbackPatch({ synced: 10, domCount: 10, base: 13, scrolled: 3 })).toEqual({
      dropHead: 0,
      appendFrom: 10
    })
  })

  it('drops from the head once the scrollback is full', () => {
    // 5000 rows on screen, 5000 in the buffer, 7 more lines scrolled: the
    // buffer stays at 5000, the oldest 7 rows are gone.
    expect(scrollbackPatch({ synced: 5000, domCount: 5000, base: 5000, scrolled: 7 })).toEqual({
      dropHead: 7,
      appendFrom: 4993
    })
  })

  it('rebuilds everything after a burst longer than the scrollback', () => {
    expect(scrollbackPatch({ synced: 5000, domCount: 5000, base: 5000, scrolled: 9000 })).toEqual({
      dropHead: 5000,
      appendFrom: 0
    })
  })

  it('empties the DOM when a sequence cleared the scrollback', () => {
    // ED 3 fires one onScroll with baseY back at 0.
    expect(scrollbackPatch({ synced: 120, domCount: 120, base: 0, scrolled: 1 })).toEqual({
      dropHead: 120,
      appendFrom: 0
    })
  })

  it('rebuilds when the DOM is not level with the parser', () => {
    expect(scrollbackPatch({ synced: 40, domCount: 12, base: 40, scrolled: 0 })).toEqual({
      dropHead: 12,
      appendFrom: 0
    })
    expect(scrollbackPatch({ synced: 0, domCount: 0, base: 30, scrolled: 0 })).toEqual({
      dropHead: 0,
      appendFrom: 0
    })
  })

  it('does nothing when nothing scrolled', () => {
    expect(scrollbackPatch({ synced: 8, domCount: 8, base: 8, scrolled: 0 })).toEqual({
      dropHead: 0,
      appendFrom: 8
    })
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
})
