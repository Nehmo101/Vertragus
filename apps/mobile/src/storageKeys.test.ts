import { describe, expect, it } from 'vitest'
import {
  DEVICE_INFO_KEY,
  DEVICE_TOKEN_KEY,
  LEGACY_DEVICE_INFO_KEY,
  LEGACY_DEVICE_TOKEN_KEY,
  readDeviceInfoJson,
  readDeviceToken,
  writeDeviceSession
} from './storageKeys'

function memoryStorage(initial: Record<string, string> = {}): Storage & {
  store: Record<string, string>
} {
  const store = { ...initial }
  return {
    store,
    get length() {
      return Object.keys(store).length
    },
    clear() {
      for (const key of Object.keys(store)) delete store[key]
    },
    getItem(key: string) {
      return Object.prototype.hasOwnProperty.call(store, key) ? store[key]! : null
    },
    setItem(key: string, value: string) {
      store[key] = String(value)
    },
    removeItem(key: string) {
      delete store[key]
    },
    key() {
      return null
    }
  }
}

describe('mobile storage keys', () => {
  it('prefers canonical Vertragus keys over legacy orca.* values', () => {
    const storage = memoryStorage({
      [DEVICE_TOKEN_KEY]: 'new-token',
      [LEGACY_DEVICE_TOKEN_KEY]: 'legacy-token',
      [DEVICE_INFO_KEY]: '{"id":"new"}',
      [LEGACY_DEVICE_INFO_KEY]: '{"id":"legacy"}'
    })
    expect(readDeviceToken(storage)).toBe('new-token')
    expect(readDeviceInfoJson(storage)).toBe('{"id":"new"}')
  })

  it('falls back to legacy orca.* keys when canonical keys are absent', () => {
    const storage = memoryStorage({
      [LEGACY_DEVICE_TOKEN_KEY]: 'legacy-token',
      [LEGACY_DEVICE_INFO_KEY]: '{"id":"legacy"}'
    })
    expect(readDeviceToken(storage)).toBe('legacy-token')
    expect(readDeviceInfoJson(storage)).toBe('{"id":"legacy"}')
  })

  it('writes only canonical keys and removes legacy duplicates (no secret leak via dual storage)', () => {
    const storage = memoryStorage({
      [LEGACY_DEVICE_TOKEN_KEY]: 'legacy-token',
      [LEGACY_DEVICE_INFO_KEY]: '{"id":"legacy"}'
    })
    writeDeviceSession(storage, 'paired-token', '{"id":"paired"}')
    expect(storage.store[DEVICE_TOKEN_KEY]).toBe('paired-token')
    expect(storage.store[DEVICE_INFO_KEY]).toBe('{"id":"paired"}')
    expect(storage.store[LEGACY_DEVICE_TOKEN_KEY]).toBeUndefined()
    expect(storage.store[LEGACY_DEVICE_INFO_KEY]).toBeUndefined()
    expect(JSON.stringify(storage.store)).not.toContain('legacy-token')
  })

  it('rejects empty unauthorized reads without inventing a token', () => {
    const storage = memoryStorage()
    expect(readDeviceToken(storage)).toBe('')
    expect(readDeviceInfoJson(storage)).toBe('')
  })
})
