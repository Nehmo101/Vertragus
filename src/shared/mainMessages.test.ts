import { describe, expect, it } from 'vitest'
import { mainMessages } from './mainMessages'

describe('mainMessages', () => {
  it('defines every key in both locales — same parity rule as the renderer bundles', () => {
    const de = mainMessages('de')
    const en = mainMessages('en')
    expect(Object.keys(en).sort()).toEqual(Object.keys(de).sort())
    for (const [key, value] of Object.entries(de)) {
      expect(typeof (en as unknown as Record<string, unknown>)[key], key).toBe(typeof value)
    }
  })

  it('falls back to German — the schema default locale — for anything unknown', () => {
    expect(mainMessages(undefined).quitDetail).toBe(mainMessages('de').quitDetail)
    expect(mainMessages('fr').quitDetail).toBe(mainMessages('de').quitDetail)
  })

  it('pluralizes the quit message in both languages', () => {
    expect(mainMessages('de').quitMessage(1)).toContain('1 Agent läuft')
    expect(mainMessages('de').quitMessage(3)).toContain('3 Agenten laufen')
    expect(mainMessages('en').quitMessage(1)).toContain('1 agent is')
    expect(mainMessages('en').quitMessage(3)).toContain('3 agents are')
  })

  it('keeps the English table actually English — no umlauts or eszett', () => {
    // Same fingerprint rule as the renderer's en.json guard: German letters in
    // an English message mean copy was pasted, not translated. Function
    // entries are exercised with sample arguments so their templates count.
    const GERMAN_LETTERS = /[äöüÄÖÜß]/
    const en = mainMessages('en')
    for (const [key, value] of Object.entries(en)) {
      const rendered =
        typeof value === 'function'
          ? (value as (...args: never[]) => string)(...(['x', 'y'] as never[]))
          : value
      expect(GERMAN_LETTERS.test(String(rendered)), key).toBe(false)
    }
  })

  it('names the login command in the auth hint, and copes without one', () => {
    expect(mainMessages('de').authNotLoggedIn('cursor-agent login', 'HTTP 401')).toBe(
      "nicht angemeldet — 'cursor-agent login' ausführen (HTTP 401)"
    )
    expect(mainMessages('en').authNotLoggedIn(undefined, 'HTTP 401')).toBe(
      'not logged in — please log in (HTTP 401)'
    )
  })

  it('translates the OS window titles instead of hard-coding them', () => {
    expect(mainMessages('de').settingsWindowTitle).toBe('Vertragus — Einstellungen')
    expect(mainMessages('en').settingsWindowTitle).toBe('Vertragus — Settings')
    expect(mainMessages('en').zoneOverlayTitle).toBe('Vertragus — Zones')
  })
})
