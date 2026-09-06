import { describe, expect, it } from 'vitest'
import { COMPACT_MAX_WIDTH_PX, isCompactChrome } from './terminalChrome'

describe('isCompactChrome', () => {
  it('folds for any coarse pointer, whatever the width', () => {
    expect(isCompactChrome({ coarse: true, widthPx: 1600 })).toBe(true)
  })

  it('folds a narrow window with a fine pointer — device mode, a split window', () => {
    expect(isCompactChrome({ coarse: false, widthPx: COMPACT_MAX_WIDTH_PX })).toBe(true)
    expect(isCompactChrome({ coarse: false, widthPx: 390 })).toBe(true)
  })

  it('leaves a wide laptop window open', () => {
    expect(isCompactChrome({ coarse: false, widthPx: COMPACT_MAX_WIDTH_PX + 1 })).toBe(false)
  })

  it('does not fold on a width it cannot read', () => {
    expect(isCompactChrome({ coarse: false, widthPx: Number.NaN })).toBe(false)
  })
})
