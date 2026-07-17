import { describe, expect, it } from 'vitest'
import { resolveLanguage } from './i18n'
import de from './locales/de.json'
import en from './locales/en.json'

describe('resolveLanguage', () => {
  it('honours explicit choices', () => {
    expect(resolveLanguage('de')).toBe('de')
    expect(resolveLanguage('en')).toBe('en')
  })

  it('falls back to a supported language for the system preference', () => {
    expect(['de', 'en']).toContain(resolveLanguage('system'))
  })
})

describe('locale resources', () => {
  function keysOf(value: unknown, prefix = ''): string[] {
    if (typeof value !== 'object' || value === null) return [prefix]
    return Object.entries(value).flatMap(([key, child]) =>
      keysOf(child, prefix ? `${prefix}.${key}` : key)
    )
  }

  it('keeps German and English key sets in sync', () => {
    expect(keysOf(en).sort()).toEqual(keysOf(de).sort())
  })

  it('leaves no empty translations', () => {
    for (const resource of [de, en]) {
      for (const key of keysOf(resource)) {
        const leaf = key.split('.').reduce<unknown>(
          (node, part) => (node as Record<string, unknown>)[part],
          resource
        )
        expect(String(leaf).trim().length, key).toBeGreaterThan(0)
      }
    }
  })
})
