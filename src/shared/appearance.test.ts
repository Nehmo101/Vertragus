import { describe, expect, it } from 'vitest'
import {
  APPEARANCE_LIMITS,
  APPEARANCE_SLIDERS,
  appearanceCssVars,
  DEFAULT_APPEARANCE,
  normalizeAppearance,
  type Appearance
} from './appearance'

describe('normalizeAppearance', () => {
  it('answers the design defaults for anything unreadable', () => {
    for (const raw of [undefined, null, 42, 'glass', [], { nonsense: true }]) {
      expect(normalizeAppearance(raw)).toEqual(DEFAULT_APPEARANCE)
    }
  })

  it('keeps a valid object as it is', () => {
    const value: Appearance = {
      translucent: true,
      restOpacity: 0.45,
      hoverOpacity: 0.8,
      focusOpacity: 0.9,
      surfaceTransparency: 0.3
    }
    expect(normalizeAppearance(value)).toEqual(value)
  })

  it('costs one bad field its value, never the whole object', () => {
    const result = normalizeAppearance({
      translucent: 'nope',
      restOpacity: 0.35,
      hoverOpacity: Number.NaN,
      surfaceTransparency: 0
    })
    expect(result.restOpacity).toBe(0.35)
    expect(result.surfaceTransparency).toBe(0)
    expect(result.translucent).toBe(DEFAULT_APPEARANCE.translucent)
    expect(result.hoverOpacity).toBe(DEFAULT_APPEARANCE.hoverOpacity)
  })

  it('clamps every slider into its own range instead of refusing it', () => {
    const low = normalizeAppearance({
      restOpacity: -3,
      hoverOpacity: 0,
      focusOpacity: 0,
      surfaceTransparency: -1
    })
    expect(low.restOpacity).toBe(APPEARANCE_LIMITS.restOpacity.min)
    expect(low.hoverOpacity).toBe(APPEARANCE_LIMITS.hoverOpacity.min)
    expect(low.surfaceTransparency).toBe(0)

    const high = normalizeAppearance({
      restOpacity: 12,
      hoverOpacity: 12,
      focusOpacity: 12,
      surfaceTransparency: 12
    })
    expect(high).toEqual({
      translucent: true,
      restOpacity: 1,
      hoverOpacity: 1,
      focusOpacity: 1,
      surfaceTransparency: 1
    })
  })

  it('lifts an inverted ladder rather than making a window vanish on hover', () => {
    const result = normalizeAppearance({
      restOpacity: 0.95,
      hoverOpacity: 0.5,
      focusOpacity: 0.45
    })
    expect(result.restOpacity).toBe(0.95)
    expect(result.hoverOpacity).toBe(0.95)
    expect(result.focusOpacity).toBe(0.95)
  })

  it('is idempotent — normalizing twice changes nothing', () => {
    const once = normalizeAppearance({ restOpacity: 0.9, hoverOpacity: 0.1, surfaceTransparency: 5 })
    expect(normalizeAppearance(once)).toEqual(once)
  })

  it('never lets the resting state drop out of sight', () => {
    expect(APPEARANCE_LIMITS.restOpacity.min).toBeGreaterThan(0.1)
  })
})

describe('appearanceCssVars', () => {
  it('maps the sliders onto the variables tokens.css is written against', () => {
    expect(
      appearanceCssVars({
        translucent: true,
        restOpacity: 0.5,
        hoverOpacity: 0.8,
        focusOpacity: 1,
        surfaceTransparency: 0.25
      })
    ).toEqual({
      '--ghost-opacity': '0.5',
      '--reveal-opacity': '0.8',
      '--focus-opacity': '1',
      '--glass-see-through': '0.25'
    })
  })

  it('resolves the master switch here, not in CSS', () => {
    const stored: Appearance = {
      translucent: false,
      restOpacity: 0.3,
      hoverOpacity: 0.6,
      focusOpacity: 0.7,
      surfaceTransparency: 1
    }
    expect(appearanceCssVars(stored)).toEqual({
      '--ghost-opacity': '1',
      '--reveal-opacity': '1',
      '--focus-opacity': '1',
      '--glass-see-through': '0'
    })
    // …and the stored sliders survive the switch untouched.
    expect(stored.restOpacity).toBe(0.3)
  })

  it('produces the mockup values for a fresh install', () => {
    expect(appearanceCssVars(DEFAULT_APPEARANCE)).toEqual({
      '--ghost-opacity': '0.6',
      '--reveal-opacity': '0.97',
      '--focus-opacity': '1',
      '--glass-see-through': '1'
    })
  })

  it('normalizes on the way out, so a bad stored value cannot reach the DOM', () => {
    const vars = appearanceCssVars({ restOpacity: 9 } as unknown as Appearance)
    expect(vars['--ghost-opacity']).toBe('1')
    expect(Number(vars['--reveal-opacity'])).toBeLessThanOrEqual(1)
  })
})

describe('the settings form contract', () => {
  it('shows every slider the appearance has, and only those', () => {
    expect([...APPEARANCE_SLIDERS].sort()).toEqual(Object.keys(APPEARANCE_LIMITS).sort())
    // `translucent` is the switch above them, not a slider.
    expect(APPEARANCE_SLIDERS).not.toContain('translucent')
  })

  it('keeps every default inside its own limits', () => {
    for (const slider of APPEARANCE_SLIDERS) {
      expect(DEFAULT_APPEARANCE[slider]).toBeGreaterThanOrEqual(APPEARANCE_LIMITS[slider].min)
      expect(DEFAULT_APPEARANCE[slider]).toBeLessThanOrEqual(APPEARANCE_LIMITS[slider].max)
    }
  })
})
