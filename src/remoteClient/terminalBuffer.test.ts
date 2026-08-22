import { describe, expect, it } from 'vitest'
import { bufferPlainText, unwrapRows, type BufferRow } from './terminalBuffer'

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

describe('unwrapRows', () => {
  const row = (text: string, wrapped = false): BufferRow => ({ text, wrapped })

  it('leaves unwrapped rows alone', () => {
    expect(unwrapRows([row('one'), row('two')])).toEqual(['one', 'two'])
  })

  it('rejoins a line the phone width broke into pieces', () => {
    expect(
      unwrapRows([row('at Object.<anony'), row('mous>:12:5', true), row('  at run', false)])
    ).toEqual(['at Object.<anonymous>:12:5', '  at run'])
  })

  it('rejoins a run of continuations, not just the first', () => {
    expect(unwrapRows([row('a'), row('b', true), row('c', true), row('d', true)])).toEqual(['abcd'])
  })

  it('starts a line for a continuation whose head was trimmed away', () => {
    expect(unwrapRows([row('mous>:12:5', true), row('next')])).toEqual(['mous>:12:5', 'next'])
  })

  it('yields nothing for no rows', () => {
    expect(unwrapRows([])).toEqual([])
  })
})

describe('unwrapRows into bufferPlainText', () => {
  it('pastes the agent line, not the phone wrap', () => {
    const rows: BufferRow[] = [
      { text: '', wrapped: false },
      { text: 'fatal: could not read Us', wrapped: false },
      { text: 'ername for https://x     ', wrapped: true },
      { text: '                        ', wrapped: false }
    ]
    expect(bufferPlainText(unwrapRows(rows))).toBe('fatal: could not read Username for https://x')
  })
})
