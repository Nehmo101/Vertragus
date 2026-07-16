import { describe, expect, it } from 'vitest'
import { calculateResizedWidth } from './useResizablePanel'

describe('calculateResizedWidth edge cases', () => {
  it('shrinks with the inverse pointer movement for right and left handles', () => {
    expect(calculateResizedWidth('sidebar-left', 300, 100, 50, 'right')).toBe(250)
    expect(calculateResizedWidth('orchestrator-right', 360, 100, 150, 'left')).toBe(310)
  })

  it('clamps both ends of the delta range in either direction', () => {
    expect(calculateResizedWidth('sidebar-left', 300, 100, -1000, 'right')).toBe(200)
    expect(calculateResizedWidth('sidebar-left', 300, 100, 1000, 'right')).toBe(480)
    expect(calculateResizedWidth('orchestrator-right', 360, 100, -1000, 'left')).toBe(560)
    expect(calculateResizedWidth('orchestrator-right', 360, 100, 1000, 'left')).toBe(240)
  })

  it('uses the panel default when pointer input cannot produce a finite delta', () => {
    expect(calculateResizedWidth('sidebar-left', 300, 100, Number.NaN, 'right')).toBe(300)
    expect(
      calculateResizedWidth('orchestrator-right', 360, 100, Number.POSITIVE_INFINITY, 'left')
    ).toBe(360)
  })
})
