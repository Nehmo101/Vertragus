import { describe, expect, it } from 'vitest'
import { CAST, CAST_NAMES, GUIDES, GUIDE_NAMES, loreBlurb } from './lore'

describe('commedia cast', () => {
  const all = [...GUIDES, ...CAST]

  it('gives every character a non-empty name and blurb', () => {
    for (const c of all) {
      expect(c.name.trim().length).toBeGreaterThan(0)
      expect(c.blurb.trim().length).toBeGreaterThan(0)
    }
  })

  it('has no duplicate names across the pools', () => {
    const names = all.map((c) => c.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('exposes name arrays that mirror the cast', () => {
    expect(GUIDE_NAMES).toEqual(GUIDES.map((c) => c.name))
    expect(CAST_NAMES).toEqual(CAST.map((c) => c.name))
  })
})

describe('loreBlurb', () => {
  it('returns the blurb for a known name', () => {
    expect(loreBlurb('Virgilio')).toMatch(/Führer/)
    expect(loreBlurb('Caronte')).toMatch(/Fährmann/)
  })

  it('resolves the allocator numbered fallback to the base character', () => {
    expect(loreBlurb('Virgilio 2')).toBe(loreBlurb('Virgilio'))
    expect(loreBlurb('Piccarda 3')).toBe(loreBlurb('Piccarda'))
  })

  it('returns undefined for unknown names and empty input', () => {
    expect(loreBlurb('Napoleon')).toBeUndefined()
    expect(loreBlurb('')).toBeUndefined()
  })
})
