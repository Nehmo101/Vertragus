import { describe, expect, it } from 'vitest'
import { stripAnsi, terminalTail } from './terminalText'

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)

describe('stripAnsi', () => {
  it('removes color, cursor and OSC sequences but keeps the text', () => {
    expect(stripAnsi(`${ESC}[32mPASS${ESC}[0m 20/20`)).toBe('PASS 20/20')
    expect(stripAnsi(`${ESC}]0;title${BEL}hello`)).toBe('hello')
    expect(stripAnsi(`${ESC}[2J${ESC}[Hclean`)).toBe('clean')
  })
})

describe('terminalTail', () => {
  it('returns the last N non-empty lines', () => {
    expect(terminalTail('a\nb\nc\n\n\n', 2)).toEqual(['b', 'c'])
  })

  it('keeps only the final state of carriage-return progress lines', () => {
    expect(terminalTail('Progress 10%\rProgress 99%\rdone\nnext', 5)).toEqual(['done', 'next'])
  })

  it('caps overlong lines with an ellipsis', () => {
    const [line] = terminalTail('x'.repeat(300), 1, 50)
    expect(line).toHaveLength(50)
    expect(line!.endsWith('…')).toBe(true)
  })
})
