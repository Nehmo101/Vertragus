/**
 * The completeness guard for the DE/EN bundle.
 *
 * A translation regresses silently: a key added to one language and not the
 * other, a `t('…')` whose key was renamed, an English string somebody typed in
 * German. None of that fails a render — it produces a raw key on screen, or a
 * German word in an English window, and nobody notices until a user does.
 *
 * So four checks run over the FILES rather than over the running app:
 *   1. de.json and en.json have exactly the same key set, and no empty leaves.
 *   2. every literal `t('…')` in the renderer resolves to a key that exists.
 *   3. every key in the bundle is used by somebody (no dead namespace).
 *   4. en.json contains no German umlauts or eszett — the reliable fingerprint
 *      of copy that was never actually translated.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import de from './locales/de.json'
import en from './locales/en.json'
import i18n, { DEFAULT_LOCALE, LOCALES, followStoredLocale, isLocale, translator } from './index'

const rendererSrc = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Every leaf path of a resource object, dotted. */
function keysOf(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix]
  return Object.entries(value).flatMap(([key, child]) =>
    keysOf(child, prefix ? `${prefix}.${key}` : key)
  )
}

const deKeys = keysOf(de)
const enKeys = keysOf(en)

/** Every `.ts`/`.tsx` of the renderer except this guard and the bundles. */
function rendererFiles(dir = rendererSrc): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return rendererFiles(full)
    if (!entry.isFile()) return []
    if (!/\.tsx?$/.test(entry.name) || entry.name.endsWith('.d.ts')) return []
    return [relative(rendererSrc, full).split(sep).join('/')]
  })
}

/**
 * Literal keys as the components write them: `t('panel.hideAll')`, and
 * `t(['settings.updateStatus.idle', fallback])` for the array form. Template
 * literals (`` t(`profileEditor.effortLevel.${level}`) ``) cannot be resolved
 * statically and are covered by the dead-key check below instead.
 */
const LITERAL_T_CALL = /\bt\(\s*\[?\s*'([A-Za-z][\w.-]*)'/g

interface Usage {
  key: string
  file: string
}

function literalUsages(): Usage[] {
  const found: Usage[] = []
  for (const file of rendererFiles()) {
    if (file === 'i18n/i18n.test.ts') continue
    const source = readFileSync(join(rendererSrc, file), 'utf8')
    for (const match of source.matchAll(LITERAL_T_CALL)) {
      found.push({ key: match[1]!, file })
    }
  }
  return found
}

/**
 * Keys reached through a computed suffix. Each entry is a key PREFIX whose
 * leaves are indexed by a closed union in the code, so the compiler — not this
 * test — is what keeps them honest. Keep the list short; every entry is a hole
 * in check 3.
 */
const DYNAMIC_KEY_PREFIXES = [
  // settings/SettingsApp.tsx — indexed by UpdateStatus
  'settings.updateStatus.',
  // profileEditor/fields.tsx — indexed by EffortLevel
  'profileEditor.effortLevel.',
  // profileEditor/model.ts — indexed by ModelDiscoveryResult['source']
  'profileEditor.modelsFrom.',
  // settings/SettingsApp.tsx — indexed by AppearanceSlider
  'settings.glassSlider.'
]

/** `panel.agentCount_one` / `_other` are one key to a caller: `panel.agentCount`. */
function callableKeys(keys: readonly string[]): Set<string> {
  const callable = new Set<string>()
  for (const key of keys) {
    callable.add(key)
    const plural = /_(zero|one|two|few|many|other)$/.exec(key)
    if (plural) callable.add(key.slice(0, -plural[0].length))
  }
  return callable
}

describe('locale bundles', () => {
  it('keeps the German and English key sets identical', () => {
    expect(enKeys.slice().sort()).toEqual(deKeys.slice().sort())
  })

  it('leaves no empty translation', () => {
    for (const [name, resource] of [
      ['de', de],
      ['en', en]
    ] as const) {
      for (const key of keysOf(resource)) {
        const leaf = key
          .split('.')
          .reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], resource)
        expect(typeof leaf, `${name}.${key}`).toBe('string')
        expect(String(leaf).trim().length, `${name}.${key}`).toBeGreaterThan(0)
      }
    }
  })

  it('interpolates the same placeholders in both languages', () => {
    const placeholders = (value: unknown): string[] =>
      [...String(value).matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]!).sort()
    const leaf = (resource: unknown, key: string): unknown =>
      key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], resource)
    for (const key of deKeys) {
      expect(placeholders(leaf(en, key)), key).toEqual(placeholders(leaf(de, key)))
    }
  })
})

describe('renderer key usage', () => {
  const usages = literalUsages()
  const callable = callableKeys(deKeys)

  it('finds the t() literals it is supposed to police', () => {
    // A regex that silently stops matching would make this whole file pass for
    // the wrong reason.
    expect(usages.length).toBeGreaterThan(150)
    expect(new Set(usages.map((usage) => usage.file)).size).toBeGreaterThan(8)
  })

  it('uses no key that the bundle does not define', () => {
    const missing = usages
      .filter((usage) => !callable.has(usage.key))
      .map((usage) => `${usage.key} (${usage.file})`)
    expect(missing, `Unknown i18n keys: ${missing.join(', ')}`).toEqual([])
  })

  it('defines no key that nobody uses', () => {
    const used = new Set(usages.map((usage) => usage.key))
    const dead = deKeys.filter((key) => {
      if (DYNAMIC_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) return false
      const base = key.replace(/_(zero|one|two|few|many|other)$/, '')
      return !used.has(key) && !used.has(base)
    })
    expect(dead, `Unused i18n keys — delete them: ${dead.join(', ')}`).toEqual([])
  })

  it('backs every dynamic prefix with real keys', () => {
    for (const prefix of DYNAMIC_KEY_PREFIXES) {
      expect(deKeys.filter((key) => key.startsWith(prefix)).length, prefix).toBeGreaterThan(0)
    }
  })
})

describe('English is actually English', () => {
  /**
   * Umlauts and eszett in `en.json` mean German copy was pasted, not
   * translated. The allowlist starts EMPTY and is meant to stay that way: a
   * proper name that genuinely carries an umlaut would go here, and nothing
   * else.
   */
  const ALLOWLIST = new Set<string>([])
  const GERMAN_LETTERS = /[äöüÄÖÜß]/

  it('has no German letters left in en.json', () => {
    const raw = JSON.parse(readFileSync(join(rendererSrc, 'i18n/locales/en.json'), 'utf8'))
    const leaf = (key: string): string =>
      String(key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], raw))
    const offenders = enKeys.filter((key) => !ALLOWLIST.has(key) && GERMAN_LETTERS.test(leaf(key)))
    expect(offenders, `German copy in en.json: ${offenders.join(', ')}`).toEqual([])
  })

  it('keeps the allowlist honest so it can only shrink', () => {
    const raw = JSON.parse(readFileSync(join(rendererSrc, 'i18n/locales/en.json'), 'utf8'))
    const stale = [...ALLOWLIST].filter((key) => {
      const value = key.split('.').reduce<unknown>(
        (node, part) => (node as Record<string, unknown> | undefined)?.[part],
        raw
      )
      return value === undefined || !GERMAN_LETTERS.test(String(value))
    })
    expect(stale, `Already clean — drop from ALLOWLIST: ${stale.join(', ')}`).toEqual([])
  })
})

describe('the i18n module itself', () => {
  it('ships both languages and defaults to the authored one', () => {
    expect([...LOCALES]).toEqual(['de', 'en'])
    expect(DEFAULT_LOCALE).toBe('de')
    expect(isLocale('de')).toBe(true)
    expect(isLocale('en')).toBe(true)
    expect(isLocale('fr')).toBe(false)
    expect(isLocale(undefined)).toBe(false)
  })

  it('translates, interpolates and pluralizes in both languages', () => {
    const dt = translator('de')
    const et = translator('en')
    expect(dt('panel.hideAll')).toBe('Alles ausblenden')
    expect(et('panel.hideAll')).toBe('Hide everything')
    expect(dt('panel.agentCount', { count: 1, working: 1 })).toBe('1/1 Agent')
    expect(dt('panel.agentCount', { count: 2, working: 1 })).toBe('1/2 Agenten')
    expect(et('panel.agentCount', { count: 1, working: 1 })).toBe('1/1 agent')
    expect(et('panel.agentCount', { count: 0, working: 0 })).toBe('0/0 agents')
    expect(et('profileEditor.autoSubmitTasks')).toBe('Submit tasks automatically')
  })

  it('does not escape interpolated values — React already does', () => {
    expect(translator('de')('zones.title', { profile: 'A & B' })).toContain('A & B')
  })
})

describe('following the stored language', () => {
  interface FakeBridge {
    getSettings(): Promise<{ locale: string }>
    onSettings(listener: (settings: { locale: string }) => void): () => void
  }

  function withBridge(bridge: FakeBridge | undefined): () => void {
    const globals = globalThis as { window?: unknown }
    const previous = globals.window
    globals.window = bridge ? { vertragus: { app: bridge } } : {}
    return () => {
      if (previous === undefined) delete globals.window
      else globals.window = previous
    }
  }

  afterEach(async () => {
    await i18n.changeLanguage(DEFAULT_LOCALE)
  })

  it('adopts the stored language before the window paints', async () => {
    const restore = withBridge({
      getSettings: () => Promise.resolve({ locale: 'en' }),
      onSettings: () => () => undefined
    })
    try {
      await followStoredLocale()
      expect(i18n.language).toBe('en')
      expect(i18n.t('panel.hideAll')).toBe('Hide everything')
    } finally {
      restore()
    }
  })

  it('follows a later broadcast, and ignores a value that is not a language', async () => {
    let push: ((settings: { locale: string }) => void) | undefined
    const restore = withBridge({
      getSettings: () => Promise.resolve({ locale: 'de' }),
      onSettings: (listener) => {
        push = listener
        return () => {
          push = undefined
        }
      }
    })
    try {
      const off = await followStoredLocale()
      expect(i18n.language).toBe('de')

      push?.({ locale: 'en' })
      await vi.waitFor(() => expect(i18n.language).toBe('en'))

      push?.({ locale: 'klingon' })
      await Promise.resolve()
      expect(i18n.language).toBe('en')

      off()
      expect(push).toBeUndefined()
    } finally {
      restore()
    }
  })

  it('keeps the default when the bridge refuses — a CLI window may not read settings', async () => {
    const restore = withBridge({
      getSettings: () => Promise.reject(new Error('settings:get rejected — not an app window')),
      onSettings: () => () => undefined
    })
    try {
      await followStoredLocale()
      expect(i18n.language).toBe(DEFAULT_LOCALE)
    } finally {
      restore()
    }
  })

  it('survives a window without any bridge at all', async () => {
    const restore = withBridge(undefined)
    try {
      const off = await followStoredLocale()
      expect(() => off()).not.toThrow()
      expect(i18n.language).toBe(DEFAULT_LOCALE)
    } finally {
      restore()
    }
  })
})
