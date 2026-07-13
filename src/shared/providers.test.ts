import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PROVIDER_LIMITS,
  normalizeProviderLimits,
  parseProviderLimits
} from './providers'

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
