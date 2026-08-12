import { describe, expect, it } from 'vitest'
import {
  normalizeTerminalChunk,
  splitIncompleteAnsiTail,
  stripAnsi,
  terminalTail,
  terminalTailText
} from './terminalText'

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)

describe('normalizeTerminalChunk', () => {
  it('turns vertical cursor moves into newlines then strips colours', () => {
    expect(normalizeTerminalChunk(`${ESC}[32mfirst${ESC}[0m${ESC}E${ESC}[31msecond${ESC}[0m`)).toBe(
      'first\nsecond'
    )
  })

  it('is what terminalTail builds on — the two paths cannot drift', () => {
    const painted = `${ESC}[1;1Hhello${ESC}[2;1Hworld`
    expect(normalizeTerminalChunk(painted).split('\n').map((line) => line.trimEnd())).toEqual(
      expect.arrayContaining(['hello', 'world'])
    )
  })
})

describe('splitIncompleteAnsiTail', () => {
  it('holds a lone ESC or incomplete CSI for the next chunk', () => {
    expect(splitIncompleteAnsiTail(`abc${ESC}`)).toEqual({ ready: 'abc', hold: ESC })
    expect(splitIncompleteAnsiTail(`abc${ESC}[31`)).toEqual({ ready: 'abc', hold: `${ESC}[31` })
  })

  it('does not hold a complete CSI or OSC', () => {
    expect(splitIncompleteAnsiTail(`x${ESC}[0my`)).toEqual({ ready: `x${ESC}[0my`, hold: '' })
    expect(splitIncompleteAnsiTail(`${ESC}]0;title${BEL}ok`)).toEqual({
      ready: `${ESC}]0;title${BEL}ok`,
      hold: ''
    })
  })
})

describe('stripAnsi', () => {
  it('removes colour, cursor and erase sequences', () => {
    expect(stripAnsi(`${ESC}[31mred${ESC}[0m`)).toBe('red')
    expect(stripAnsi(`a${ESC}[2Kb${ESC}[1;2Hc`)).toBe('abc')
  })

  it('removes OSC window-title and hyperlink sequences', () => {
    expect(stripAnsi(`${ESC}]0;claude${BEL}ready`)).toBe('ready')
  })

  it('keeps newlines and carriage returns for the line logic', () => {
    expect(stripAnsi('a\r\nb')).toBe('a\r\nb')
  })

  it('drops stray control characters but not printable text', () => {
    expect(stripAnsi(`bell${BEL}ok`)).toBe('bellok')
  })
})

describe('terminalTail', () => {
  it('keeps only the final state of a carriage-return redraw', () => {
    // What a spinner leaves in the scrollback vs. what the user actually sees.
    const spinner = 'thinking |\rthinking /\rthinking -\rdone.\n'
    expect(terminalTail(spinner, 5)).toEqual(['done.'])
  })

  it('returns the last N lines and drops trailing blanks', () => {
    expect(terminalTail('one\ntwo\nthree\n\n\n', 2)).toEqual(['two', 'three'])
  })

  it('truncates absurdly long lines with an ellipsis', () => {
    const [line] = terminalTail(`${'x'.repeat(50)}\n`, 1, 10)
    expect(line).toBe(`${'x'.repeat(9)}…`)
  })

  it('always returns at least one line for a non-positive count', () => {
    expect(terminalTail('only\n', 0)).toEqual(['only'])
  })

  it('reads cursor-positioned TUI frames instead of returning nothing', () => {
    // An alternate-screen CLI paints rows via CUP and never emits \n. Before
    // the cursor-break handling this whole buffer collapsed to an empty tail.
    const frame =
      `${ESC}[?1049h${ESC}[2J${ESC}[1;1Hcursor-agent` +
      `${ESC}[2;1Hstatus: working${ESC}[1;1Hcursor-agent${ESC}[2;1Hstatus: done`
    const tail = terminalTail(frame, 10)
    expect(tail.length).toBeGreaterThan(0)
    expect(tail).toContain('status: done')
    expect(tail).toContain('cursor-agent')
  })

  it('collapses a repaint loop that redraws identical text every tick', () => {
    const repaints = Array.from({ length: 50 }, () => `${ESC}[1;1Hworking on it`).join('')
    expect(terminalTail(repaints, 10)).toEqual(['working on it'])
  })

  it('treats ESC E / ESC M index moves as line breaks', () => {
    expect(terminalTail(`first${ESC}Esecond${ESC}Mthird`, 10)).toEqual([
      'first',
      'second',
      'third'
    ])
  })

  it('joins to the plain block read_output returns', () => {
    expect(terminalTailText(`${ESC}[32mgreen${ESC}[0m\nplain\n`, 5)).toBe('green\nplain')
  })
})
