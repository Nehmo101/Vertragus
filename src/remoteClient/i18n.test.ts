/**
 * The completeness guard for the remote client's copy — the same discipline
 * as the renderer's `i18n/i18n.test.ts`, adapted to this bundle's shape: the
 * copy is a typed object per locale (the compiler already pins the key sets),
 * so what can still drift silently is an EMPTY string, a function pair whose
 * arities diverge, or English copy that was pasted from the German column
 * instead of translated.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { remoteCopy, remoteLanguage, type RemoteCopy } from './i18n'

const de = remoteCopy('de')
const en = remoteCopy('en')

/** Render one copy value to text; function fields get sample arguments. */
function rendered(value: RemoteCopy[keyof RemoteCopy]): string {
  return typeof value === 'function' ? (value as (arg: never) => string)(2 as never) : value
}

describe('remote copy bundles', () => {
  it('leaves no empty copy in either language', () => {
    for (const [name, copy] of [
      ['de', de],
      ['en', en]
    ] as const) {
      for (const [key, value] of Object.entries(copy)) {
        expect(rendered(value).trim().length, `${name}.${key}`).toBeGreaterThan(0)
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
    expect(remoteCopy('de').connected).toBe('verbunden')
    expect(remoteCopy('en').connected).toBe('connected')
    // BCP-47 variants of English count as English; anything unknown stays German.
    expect(remoteCopy('en-US').connected).toBe('connected')
    expect(remoteCopy('fr').connected).toBe('verbunden')
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

/**
 * Reachability: a copy key nothing renders is a key that rots. Three shipped
 * unreferenced before this guard existed, one of them written for an error the
 * user was instead shown "unknown error" for.
 *
 * Copy reaches a screen three ways, and the scan has to know all three or it
 * reports live keys as dead: a plain property read (`copy.stop`), a read
 * through a ref because the caller is inside a closure that outlived its render
 * (`copyRef.current.terminalExit`), and a computed lookup where the key name is
 * chosen at runtime — `copy[api.error]`, and the connection pill's state name.
 * The last is covered by looking for the key as a string literal, and that is
 * not a loophole — it is the same fact stated from the other side: for
 * `copy[state]` to resolve, the name has to be written down somewhere the
 * lookup can reach, so a key nothing writes down is a key nothing can read.
 * Seven live keys depend on this branch (`RemoteError`'s two causes and the
 * five connection states), so weakening it to a plain `copy.<key>` scan would
 * report all seven as dead and invite deleting the check instead.
 */
describe('every copy key reaches a screen', () => {
  const clientDir = dirname(fileURLToPath(import.meta.url))

  /** Every client source that could render copy — the copy itself excluded. */
  function consumerSources(): string {
    return readdirSync(clientDir)
      .filter((name) => /\.tsx?$/.test(name) && !name.endsWith('.test.ts') && name !== 'i18n.ts')
      .map((name) => readFileSync(join(clientDir, name), 'utf8'))
      .join('\n')
  }

  /**
   * Only the seven keys that genuinely cannot be found by a property read: the
   * two `RemoteError` causes rendered as `copy[api.error]`, and the five
   * connection states rendered through `connectionLabel`'s `copy[state]`.
   * Narrow, because the literal branch is the loose one — `'goal'` and
   * `'retry'` are ordinary words that appear all over the client for reasons
   * having nothing to do with copy.
   */
  const COMPUTED_KEYS = new Set<keyof RemoteCopy>([
    'pairingFailed',
    'unreachable',
    'connected',
    'connecting',
    'reconnecting',
    'checking',
    'offline'
  ])

  /**
   * A property read on the copy object specifically — not on anything that
   * happens to share the name. `history.back()` must not count as proof that
   * `copy.back` reaches a screen, and `api.refresh` must not vouch for
   * `copy.refresh`; both did under a bare `\.key` scan, along with 22 others.
   */
  function renders(sources: string, key: keyof RemoteCopy): boolean {
    if (COMPUTED_KEYS.has(key)) return sources.includes(`'${key}'`)
    return new RegExp(`\\bcopy(Ref\\.current)?\\.${key}\\b`).test(sources)
  }

  it('leaves no key unreferenced', () => {
    const sources = consumerSources()
    const dead = (Object.keys(de) as (keyof RemoteCopy)[]).filter((key) => !renders(sources, key))
    expect(dead, 'copy keys no screen renders').toEqual([])
  })

  it('would notice if its own scan stopped finding consumers', () => {
    // A glob that matched nothing, or a matcher that matched everything, would
    // green the check above vacuously. Pin both ends.
    const sources = consumerSources()
    expect(sources).toContain('copy.')
    expect(renders(sources, 'stop')).toBe(true)
    // The ref form is the one a bare `copy.` scan would miss.
    expect(renders(sources, 'terminalExit')).toBe(true)
    // And the narrowing itself: `back` is a key AND a DOM method this client
    // calls. Strip only the copy reads and the key must read as dead, even
    // though `history.back()` is still there vouching for the bare name. A
    // looser matcher passes this line and fails the point of it.
    const withoutCopyBack = sources.replace(/\bcopy(Ref\.current)?\.back\b/g, 'x.y')
    expect(withoutCopyBack).toContain('history.back()')
    expect(renders(withoutCopyBack, 'back')).toBe(false)
  })
})
