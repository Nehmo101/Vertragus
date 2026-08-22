import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { StorageLike } from './navState'
import {
  nextThemePreference,
  parseThemePreference,
  readThemePreference,
  resolveTheme,
  themeColorFrom,
  themeGlyph,
  themePreferenceLabel,
  THEME_KEY,
  writeThemePreference,
  type ThemePreference
} from './themePreference'

function memoryStorage(seed: Record<string, string> = {}): StorageLike {
  const data = new Map(Object.entries(seed))
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value)
    }
  }
}

describe('theme preference', () => {
  it('defaults to following the desktop, including for junk', () => {
    expect(parseThemePreference(undefined)).toBe('host')
    expect(parseThemePreference('sepia')).toBe('host')
    expect(parseThemePreference('light')).toBe('light')
    expect(readThemePreference(memoryStorage())).toBe('host')
  })

  it('round-trips through storage', () => {
    const storage = memoryStorage()
    writeThemePreference('dark', storage)
    expect(storage.getItem(THEME_KEY)).toBe('dark')
    expect(readThemePreference(storage)).toBe('dark')
  })

  it('composes with the host theme', () => {
    expect(resolveTheme('host', 'light')).toBe('light')
    expect(resolveTheme('host', 'dark')).toBe('dark')
    expect(resolveTheme('light', 'dark')).toBe('light')
    expect(resolveTheme('dark', 'light')).toBe('dark')
  })

  it('cycles through all three states and back', () => {
    const seen: ThemePreference[] = ['host']
    for (let step = 0; step < 3; step += 1) seen.push(nextThemePreference(seen[step]!))
    expect(seen).toEqual(['host', 'dark', 'light', 'host'])
  })

  it('names and marks every state', () => {
    const copy = { themeFollowHost: 'Desktop folgen', themeDark: 'Dunkel', themeLight: 'Hell' }
    expect(themePreferenceLabel('host', copy)).toBe('Desktop folgen')
    expect(themePreferenceLabel('dark', copy)).toBe('Dunkel')
    expect(themePreferenceLabel('light', copy)).toBe('Hell')
    expect(new Set((['host', 'dark', 'light'] as const).map(themeGlyph)).size).toBe(3)
  })
})

describe('theme colour', () => {
  it('consumes the computed token when the sheet has applied', () => {
    expect(themeColorFrom(' #101418 ', 'dark')).toBe('#101418')
  })

  it('falls back per theme before the sheet applies', () => {
    expect(themeColorFrom(undefined, 'dark')).toBe('#0e1013')
    expect(themeColorFrom('', 'light')).toBe('#f4f1ea')
    expect(themeColorFrom('   ', 'light')).toBe('#f4f1ea')
  })

  /**
   * The fallback restates `--bg`, and a restated colour drifts. The runtime
   * path reads the computed token and cannot drift; this pair is the one copy
   * that can, so it is held against the sheet itself — the same file-reading
   * guard this project uses for its other cross-cutting values, self-checked
   * so a reshaped sheet fails loudly instead of quietly scanning nothing.
   */
  it('states the same --bg the sheet does, in both themes', () => {
    const sheet = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'styles.css'),
      'utf8'
    )
    const lightStart = sheet.indexOf(":root[data-theme='light']")
    expect(lightStart, 'the light token block moved').toBeGreaterThan(-1)
    const bgIn = (block: string): string | undefined => /--bg:\s*(#[0-9a-fA-F]{3,8});/.exec(block)?.[1]
    const dark = bgIn(sheet.slice(0, lightStart))
    const light = bgIn(sheet.slice(lightStart))
    expect(dark, 'no --bg in the dark token block').toBeDefined()
    expect(light, 'no --bg in the light token block').toBeDefined()
    expect(dark).not.toBe(light)
    expect(themeColorFrom(undefined, 'dark')).toBe(dark)
    expect(themeColorFrom(undefined, 'light')).toBe(light)
  })
})
