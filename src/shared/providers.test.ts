import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MODELS,
  DEFAULT_PROVIDER_LIMITS,
  normalizeProviderLimits,
  parseProviderLimits
} from './providers'

describe('model catalogue fallbacks', () => {
  it('keeps account-dependent Claude and Cursor choices live-only', () => {
    expect(DEFAULT_MODELS.claude).toEqual([])
    expect(DEFAULT_MODELS.cursor).toEqual([])
  })

  it('uses canonical Codex CLI identifiers without obsolete aliases', () => {
    expect(DEFAULT_MODELS.codex).toEqual(
      expect.arrayContaining(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'])
    )
    expect(DEFAULT_MODELS.codex).not.toEqual(
      expect.arrayContaining(['gpt-5.6', 'gpt-5.6-codex'])
    )
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
