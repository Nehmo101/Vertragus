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

  it('keeps canvas composer + voice overlay surface keys in DE/EN parity', () => {
    const required = [
      'canvas.composer.startMode',
      'canvas.composer.label',
      'canvas.composer.placeholder',
      'canvas.composer.startPlaceholder',
      'canvas.composer.voice',
      'canvas.composer.send',
      'canvas.thread.label',
      'voiceOverlay.toggle',
      'voiceOverlay.hide',
      'voiceOverlay.confirmation',
      'voiceOverlay.yesValue',
      'voiceOverlay.noValue',
      'voiceOverlay.state.listening',
      'voiceOverlay.state.thinking',
      'voiceOverlay.state.speaking'
    ]
    const deKeys = new Set(keysOf(de))
    const enKeys = new Set(keysOf(en))
    for (const key of required) {
      expect(deKeys.has(key), `missing DE key ${key}`).toBe(true)
      expect(enKeys.has(key), `missing EN key ${key}`).toBe(true)
    }
  })
})
