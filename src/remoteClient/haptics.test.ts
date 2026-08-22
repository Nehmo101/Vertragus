import { describe, expect, it } from 'vitest'
import { hapticPattern } from './haptics'

describe('haptic patterns', () => {
  it('keeps every buzz short enough to read as feedback, not an error', () => {
    for (const kind of ['tap', 'confirm', 'warn'] as const) {
      const pattern = hapticPattern(kind)
      const pulses = typeof pattern === 'number' ? [pattern] : pattern.filter((_, i) => i % 2 === 0)
      for (const pulse of pulses) expect(pulse, kind).toBeLessThanOrEqual(30)
      expect(pulses.length, kind).toBeGreaterThan(0)
    }
  })

  it('escalates: a destructive action buzzes longer than a plain tap', () => {
    const tap = hapticPattern('tap') as number
    const warn = (hapticPattern('warn') as number[])[0]
    expect(warn).toBeGreaterThan(tap)
  })
})
