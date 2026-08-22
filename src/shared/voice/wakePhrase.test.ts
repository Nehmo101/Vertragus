import { describe, expect, it } from 'vitest'
import { matchWakePhrase, normalizeWake } from './wakePhrase'

describe('normalizeWake', () => {
  it('lowercases, trims, collapses space and strips punctuation', () => {
    expect(normalizeWake('  Hey,  Vertragus! ')).toBe('hey vertragus')
  })

  it('folds German umlauts so STT spelling drift still matches', () => {
    expect(normalizeWake('Größe')).toBe('grosse')
    expect(normalizeWake('ÄÖÜß')).toBe('aouss')
  })
})

describe('matchWakePhrase', () => {
  it('hits Bei Fu0 at the start and keeps the command as remainder', () => {
    const result = matchWakePhrase(
      'Bei Fu0 starte den UWE workspace mit Ziel xyz',
      'Bei Fu0'
    )
    expect(result.hit).toBe(true)
    expect(result.remainder.startsWith('starte')).toBe(true)
    expect(result.remainder).toContain('UWE')
  })

  it('hits after a short filler and ignores trailing punctuation', () => {
    expect(matchWakePhrase('Hey Vertragus.', 'Vertragus')).toEqual({
      hit: true,
      remainder: ''
    })
    expect(matchWakePhrase('Hallo Vertragus, starte UWE', 'Vertragus')).toEqual({
      hit: true,
      remainder: 'starte UWE'
    })
  })

  it('allows one Levenshtein error on long wake tokens', () => {
    expect(matchWakePhrase('Hey Vertragvs starte', 'Vertragus')).toEqual({
      hit: true,
      remainder: 'starte'
    })
  })

  it('does not treat fu-null as fu0', () => {
    expect(matchWakePhrase('Bei funull starte', 'Bei Fu0').hit).toBe(false)
    expect(matchWakePhrase('Bei Fu0 starte', 'Bei Fu0').hit).toBe(true)
  })

  it('does not hit unrelated speech or an empty wake phrase', () => {
    expect(matchWakePhrase('wie ist das Wetter', 'Vertragus').hit).toBe(false)
    expect(matchWakePhrase('Vertragus starte', '').hit).toBe(false)
    expect(matchWakePhrase('', 'Vertragus').hit).toBe(false)
  })

  it('matches umlaut-folded wake tokens', () => {
    expect(matchWakePhrase('Hallo Größe bitte starten', 'Grösse')).toEqual({
      hit: true,
      remainder: 'bitte starten'
    })
  })

  it('is case-insensitive', () => {
    expect(matchWakePhrase('HEY VERTRAGUS GO', 'vertragus').remainder).toBe('GO')
  })
})
