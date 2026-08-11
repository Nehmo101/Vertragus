import { describe, expect, it } from 'vitest'
import { stripAnsi, terminalTail, terminalTailText } from './terminalText'

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)

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

  it('joins to the plain block read_output returns', () => {
    expect(terminalTailText(`${ESC}[32mgreen${ESC}[0m\nplain\n`, 5)).toBe('green\nplain')
  })
})
