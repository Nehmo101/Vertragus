import { describe, expect, it } from 'vitest'
import {
  FELLOWSHIP,
  FELLOWSHIP_NAMES,
  LEADERS,
  LEADER_NAMES,
  tolkienBlurb
} from './tolkien'

describe('tolkien cast', () => {
  const all = [...LEADERS, ...FELLOWSHIP]

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
    expect(LEADER_NAMES).toEqual(LEADERS.map((c) => c.name))
    expect(FELLOWSHIP_NAMES).toEqual(FELLOWSHIP.map((c) => c.name))
  })
})

describe('tolkienBlurb', () => {
  it('returns the blurb for a known name', () => {
    expect(tolkienBlurb('Gandalf')).toMatch(/Zauberer/)
    expect(tolkienBlurb('Smaug')).toMatch(/Drache/)
  })

  it('resolves the allocator numbered fallback to the base character', () => {
    expect(tolkienBlurb('Gandalf 2')).toBe(tolkienBlurb('Gandalf'))
    expect(tolkienBlurb('Tom Bombadil 3')).toBe(tolkienBlurb('Tom Bombadil'))
  })

  it('returns undefined for unknown names and empty input', () => {
    expect(tolkienBlurb('Napoleon')).toBeUndefined()
    expect(tolkienBlurb('')).toBeUndefined()
  })
})
