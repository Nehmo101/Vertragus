import { describe, expect, it } from 'vitest'
import { bufferPlainText } from './terminalBuffer'

describe('bufferPlainText', () => {
  it('joins rows with newlines', () => {
    expect(bufferPlainText(['one', 'two'])).toBe('one\ntwo')
  })

  it('strips the grid padding from every row', () => {
    expect(bufferPlainText(['$ ls    ', 'src   \t'])).toBe('$ ls\nsrc')
  })

  it('drops the empty rows above and below the output', () => {
    expect(bufferPlainText(['', '   ', 'output', '', '    '])).toBe('output')
  })

  it('keeps the blank lines inside the output', () => {
    expect(bufferPlainText(['first', '', 'second'])).toBe('first\n\nsecond')
  })

  it('yields nothing for an empty or blank buffer', () => {
    expect(bufferPlainText([])).toBe('')
    expect(bufferPlainText(['', '  ', ''])).toBe('')
  })
})
