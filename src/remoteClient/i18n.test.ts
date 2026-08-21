/**
 * The completeness guard for the remote client's copy — the same discipline
 * as the renderer's `i18n/i18n.test.ts`, adapted to this bundle's shape: the
 * copy is a typed object per locale (the compiler already pins the key sets),
 * so what can still drift silently is an EMPTY string, a function pair whose
 * arities diverge, or English copy that was pasted from the German column
 * instead of translated.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { remoteCopy, remoteLanguage, type RemoteCopy } from './i18n'

const de = remoteCopy('de')
const en = remoteCopy('en')

/**
 * Render one copy value to text. Function fields get one dummy argument per
 * declared parameter — a single `2` would leave a two-arg interpolator
 * (`agents(working, count)`) printing `undefined` and still look non-empty.
 */
function rendered(value: RemoteCopy[keyof RemoteCopy]): string {
  if (typeof value !== 'function') return value
  const samples = Array.from({ length: Math.max(value.length, 1) }, () => 2 as never)
  return (value as (...args: never[]) => string)(...samples)
}

describe('remote copy bundles', () => {
  it('leaves no empty copy in either language', () => {
    for (const [name, copy] of [
      ['de', de],
      ['en', en]
    ] as const) {
      for (const [key, value] of Object.entries(copy)) {
        const text = rendered(value)
        expect(text.trim().length, `${name}.${key}`).toBeGreaterThan(0)
        expect(text, `${name}.${key}`).not.toContain('undefined')
      }
    }
  })

  it('keeps every function pair at the same arity', () => {
    for (const key of Object.keys(de) as (keyof RemoteCopy)[]) {
      const deValue = de[key]
      const enValue = en[key]
      expect(typeof enValue, key).toBe(typeof deValue)
      if (typeof deValue === 'function' && typeof enValue === 'function') {
        expect(enValue.length, key).toBe(deValue.length)
      }
    }
  })
})

describe('English is actually English', () => {
  /**
   * Umlauts and eszett in the `en` object mean German copy was pasted, not
   * translated. The allowlist holds the exact trimmed source LINES that are
   * allowed to carry one (a proper name, nothing else); it starts EMPTY, and
   * the honesty check below makes sure it can only shrink.
   */
  const ALLOWLIST = new Set<string>([])
  const GERMAN_LETTERS = /[äöüÄÖÜß]/

  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'i18n.ts'), 'utf8')
  const enStart = source.indexOf('const en: RemoteCopy')
  const enEnd = source.indexOf('export function remoteCopy')
  const enSource = source.slice(enStart, enEnd)

  it('finds the en object it is supposed to police', () => {
    // A moved marker would silently shrink the scan to nothing.
    expect(enStart).toBeGreaterThan(-1)
    expect(enEnd).toBeGreaterThan(enStart)
    expect(enSource).toContain('pairingFailed')
  })

  it('has no German letters left in the en object source', () => {
    const offenders = enSource
      .split('\n')
      .filter((line) => GERMAN_LETTERS.test(line) && !ALLOWLIST.has(line.trim()))
    expect(offenders, `German copy in remote en bundle: ${offenders.join(' | ')}`).toEqual([])
  })

  it('keeps the allowlist honest so it can only shrink', () => {
    const lines = enSource.split('\n')
    const stale = [...ALLOWLIST].filter(
      (entry) => !lines.some((line) => line.trim() === entry && GERMAN_LETTERS.test(line))
    )
    expect(stale, `Already clean — drop from ALLOWLIST: ${stale.join(' | ')}`).toEqual([])
  })
})

describe('locale resolution', () => {
  it('follows the desktop hello.locale, defaulting to the authored German', () => {
    expect(remoteCopy('de').brandRemote).toBe('Fernzugriff')
    expect(remoteCopy('en').brandRemote).toBe('Remote')
    // BCP-47 variants of English count as English; anything unknown stays German.
    expect(remoteCopy('en-US').brandRemote).toBe('Remote')
    expect(remoteCopy('fr').brandRemote).toBe('Fernzugriff')
  })

  it('reduces the locale to the `lang` the document gets, by the same rule', () => {
    // App.tsx writes this into `document.documentElement.lang`; index.html can
    // only carry a placeholder, since one static bundle serves both languages.
    // Copy and `lang` must come from the same decision or a German phone
    // announces itself as English to the screen reader.
    expect(remoteLanguage('de')).toBe('de')
    expect(remoteLanguage('en')).toBe('en')
    expect(remoteLanguage('EN-GB')).toBe('en')
    expect(remoteLanguage('fr')).toBe('de')
    for (const locale of ['de', 'en', 'en-US', 'fr', '']) {
      expect(remoteCopy(locale), locale).toBe(remoteCopy(remoteLanguage(locale)))
    }
  })
})
