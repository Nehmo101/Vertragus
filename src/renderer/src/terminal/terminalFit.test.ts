import { describe, expect, it } from 'vitest'
import { ptyFitSize, type TerminalFitSize } from './terminalFit'

function fitted(overrides: Partial<TerminalFitSize> = {}): TerminalFitSize {
  return { cols: 160, rows: 50, ...overrides }
}

describe('ptyFitSize', () => {
  it('sends the first real size a laid-out view produces', () => {
    expect(ptyFitSize(fitted())).toEqual({ cols: 160, rows: 50 })
  })

  it('sends nothing before the view is laid out', () => {
    // FitAddon returns undefined rather than throwing; without this the first
    // pass would send xterm's untouched 80×24.
    expect(ptyFitSize(undefined)).toBeUndefined()
  })

  it('sends nothing for a size that is not a pair of numbers', () => {
    expect(ptyFitSize(fitted({ cols: Number.NaN }))).toBeUndefined()
    expect(ptyFitSize(fitted({ rows: Number.NaN }))).toBeUndefined()
    expect(ptyFitSize(fitted({ cols: Number.POSITIVE_INFINITY }))).toBeUndefined()
  })

  it('sends nothing for a non-positive size', () => {
    expect(ptyFitSize(fitted({ cols: 0 }))).toBeUndefined()
    expect(ptyFitSize(fitted({ rows: 0 }))).toBeUndefined()
    expect(ptyFitSize(fitted({ cols: -1 }))).toBeUndefined()
  })

  it('floors a fractional proposal', () => {
    expect(ptyFitSize({ cols: 160.9, rows: 50.2 })).toEqual({ cols: 160, rows: 50 })
  })

  it('says nothing when the PTY already has this size', () => {
    expect(ptyFitSize(fitted(), { cols: 160, rows: 50 })).toBeUndefined()
  })

  it('speaks up when either dimension actually moved', () => {
    expect(ptyFitSize(fitted(), { cols: 160, rows: 24 })).toEqual({ cols: 160, rows: 50 })
    expect(ptyFitSize(fitted(), { cols: 80, rows: 50 })).toEqual({ cols: 160, rows: 50 })
  })
})
