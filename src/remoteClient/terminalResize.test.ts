import { describe, expect, it } from 'vitest'
import { MIN_HOST_COLS, MIN_HOST_ROWS, hostResize, type ResizeInput } from './terminalResize'

function input(overrides: Partial<ResizeInput> = {}): ResizeInput {
  return {
    fitted: { cols: 38, rows: 30 },
    sent: undefined,
    local: false,
    transient: false,
    ...overrides
  }
}

describe('hostResize', () => {
  it('sends the first real size a laid-out view produces', () => {
    expect(hostResize(input())).toEqual({ cols: 38, rows: 30 })
  })

  it('sends nothing before the view is laid out', () => {
    // FitAddon returns undefined rather than throwing, which is why the caller
    // has to ask instead of wrapping fit() in a try.
    expect(hostResize(input({ fitted: undefined }))).toBeUndefined()
  })

  it('sends nothing for a size that is not a pair of numbers', () => {
    expect(hostResize(input({ fitted: { cols: Number.NaN, rows: 30 } }))).toBeUndefined()
    expect(hostResize(input({ fitted: { cols: 38, rows: Number.NaN } }))).toBeUndefined()
  })

  it('refuses to drive the shared PTY down to a keyboard-sized viewport', () => {
    expect(hostResize(input({ fitted: { cols: 38, rows: MIN_HOST_ROWS - 1 } }))).toBeUndefined()
    expect(hostResize(input({ fitted: { cols: MIN_HOST_COLS - 1, rows: 30 } }))).toBeUndefined()
  })

  it('keeps a font tap local to this phone', () => {
    expect(hostResize(input({ local: true }))).toBeUndefined()
  })

  it('keeps a keyboard-shrunk viewport local to this phone', () => {
    expect(hostResize(input({ transient: true }))).toBeUndefined()
  })

  it('says nothing when the host already has this size', () => {
    expect(hostResize(input({ sent: { cols: 38, rows: 30 } }))).toBeUndefined()
  })

  it('speaks up when either dimension actually moved', () => {
    expect(hostResize(input({ sent: { cols: 38, rows: 24 } }))).toEqual({ cols: 38, rows: 30 })
    expect(hostResize(input({ sent: { cols: 30, rows: 30 } }))).toEqual({ cols: 38, rows: 30 })
  })

  it('does not let a keyboard open-and-close cycle reach the host at all', () => {
    const steady = { cols: 38, rows: 30 }
    const sent = hostResize(input({ fitted: steady }))
    expect(sent).toEqual(steady)
    // Keyboard up: a smaller fit, marked transient.
    expect(hostResize(input({ fitted: { cols: 38, rows: 12 }, sent, transient: true }))).toBe(
      undefined
    )
    // Keyboard down: back to the size the host already has.
    expect(hostResize(input({ fitted: steady, sent }))).toBeUndefined()
  })
})
