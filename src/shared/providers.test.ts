import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MODELS,
  DEFAULT_PROVIDER_LIMITS,
  normalizeProviderLimits,
  parseProviderLimits
} from './providers'

describe('model catalogue fallbacks', () => {
  it('keeps stable Claude aliases and useful Cursor fallback suggestions visible', () => {
    expect(DEFAULT_MODELS.claude).toEqual(
      expect.arrayContaining(['sonnet', 'opus', 'haiku', 'fable'])
    )
    expect(DEFAULT_MODELS.cursor).toEqual(
      expect.arrayContaining(['auto', 'composer-2.5', 'composer-2.5-fast'])
    )
  })

  it('uses canonical Codex CLI identifiers without obsolete aliases', () => {
    expect(DEFAULT_MODELS.codex).toEqual(
      expect.arrayContaining(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'])
    )
    expect(DEFAULT_MODELS.codex).not.toEqual(
      expect.arrayContaining(['gpt-5.6', 'gpt-5.6-codex'])
    )
  })

  it('uses current standalone Copilot CLI model identifiers', () => {
    expect(DEFAULT_MODELS.copilot).toEqual(
      expect.arrayContaining([
        'auto',
        'claude-sonnet-4.6',
        'gpt-5.4',
        'claude-haiku-4.5',
        'gpt-5.3-codex'
      ])
    )
    expect(DEFAULT_MODELS.copilot).not.toContain('claude-sonnet-4.5')
  })
})

describe('provider gate limits', () => {
  it('keeps Cursor at the safe default of four and accepts a configurable Claude gate', () => {
    expect(normalizeProviderLimits({ claude: 7 })).toEqual({
      ...DEFAULT_PROVIDER_LIMITS,
      claude: 7,
      cursor: 4
    })
  })

  it('uses safe defaults for malformed persisted values', () => {
    expect(normalizeProviderLimits({ claude: 0, cursor: '4', codex: Number.NaN })).toEqual(
      DEFAULT_PROVIDER_LIMITS
    )
  })

  it('rejects unsafe renderer updates', () => {
    expect(() => parseProviderLimits({ cursor: 17 })).toThrow(/zwischen 1 und 16/)
    expect(() => parseProviderLimits({ claude: 1.5 })).toThrow(/ganze Zahl/)
    expect(() => parseProviderLimits({ quota: 4 })).toThrow(/Unbekanntes Orca-Gate/)
  })
})
