import { describe, expect, it } from 'vitest'
import {
  FONT_DEFAULT,
  FONT_MAX,
  FONT_MIN,
  FONT_STORAGE_KEY,
  clampFontSize,
  localFontStore,
  readFontSize,
  writeFontSize,
  type FontStore
} from './terminalFont'

function fakeStore(initial?: string): FontStore & { value: string | null } {
  return {
    value: initial ?? null,
    getItem(key: string): string | null {
      return key === FONT_STORAGE_KEY ? this.value : null
    },
    setItem(key: string, value: string): void {
      if (key === FONT_STORAGE_KEY) this.value = value
    }
  }
}

const throwingStore: FontStore = {
  getItem(): string | null {
    throw new Error('SecurityError')
  },
  setItem(): void {
    throw new Error('QuotaExceededError')
  }
}

describe('clampFontSize', () => {
  it('rounds to a whole pixel', () => {
    expect(clampFontSize(14.4)).toBe(14)
    expect(clampFontSize(14.6)).toBe(15)
  })

  it('holds the readable range', () => {
    expect(clampFontSize(FONT_MIN - 5)).toBe(FONT_MIN)
    expect(clampFontSize(FONT_MAX + 5)).toBe(FONT_MAX)
  })

  it('falls back to the default for a number that is not one', () => {
    expect(clampFontSize(Number.NaN)).toBe(FONT_DEFAULT)
    expect(clampFontSize(Number.POSITIVE_INFINITY)).toBe(FONT_DEFAULT)
  })
})

describe('readFontSize', () => {
  it('returns the default without a store', () => {
    expect(readFontSize(undefined)).toBe(FONT_DEFAULT)
  })

  it('returns the default when nothing was stored', () => {
    expect(readFontSize(fakeStore())).toBe(FONT_DEFAULT)
  })

  it('reads back what was written', () => {
    const store = fakeStore()
    writeFontSize(store, 19)
    expect(readFontSize(store)).toBe(19)
  })

  it('repairs a value from outside the range', () => {
    expect(readFontSize(fakeStore('99'))).toBe(FONT_MAX)
    expect(readFontSize(fakeStore('2'))).toBe(FONT_MIN)
  })

  it('survives a value that is not a number', () => {
    expect(readFontSize(fakeStore('groß'))).toBe(FONT_DEFAULT)
  })

  it('survives a store that throws on access — private mode', () => {
    expect(readFontSize(throwingStore)).toBe(FONT_DEFAULT)
  })
})

describe('writeFontSize', () => {
  it('stores the clamped value as text', () => {
    const store = fakeStore()
    writeFontSize(store, 40)
    expect(store.value).toBe(String(FONT_MAX))
  })

  it('swallows a storage that refuses to write', () => {
    expect(() => writeFontSize(throwingStore, 16)).not.toThrow()
    expect(() => writeFontSize(undefined, 16)).not.toThrow()
  })
})

describe('localFontStore', () => {
  it('yields nothing where there is no window at all', () => {
    expect(localFontStore()).toBeUndefined()
  })
})
