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
})
