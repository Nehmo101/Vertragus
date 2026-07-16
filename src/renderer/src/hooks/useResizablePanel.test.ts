import { describe, expect, it } from 'vitest'
import { calculateResizedWidth } from './useResizablePanel'

describe('calculateResizedWidth', () => {
  it('grows a panel from a handle on its right edge with positive pointer movement', () => {
    expect(calculateResizedWidth('sidebar-left', 300, 100, 140, 'right')).toBe(340)
  })

  it('grows a panel from a handle on its left edge with negative pointer movement', () => {
    expect(calculateResizedWidth('orchestrator-right', 360, 100, 60, 'left')).toBe(400)
  })

  it('clamps live resize results to the selected panel limits', () => {
    expect(calculateResizedWidth('sidebar-left', 300, 100, 1000, 'right')).toBe(480)
    expect(calculateResizedWidth('orchestrator-right', 360, 100, 1000, 'left')).toBe(240)
  })
})
