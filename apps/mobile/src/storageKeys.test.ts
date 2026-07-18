import { describe, expect, it } from 'vitest'
import {
  readRemoteDevice,
  readRemoteToken,
  writeRemoteDevice,
  writeRemoteToken,
  REMOTE_DEVICE_KEY,
  REMOTE_TOKEN_KEY,
  type KeyValueStore
} from './storageKeys'

const LEGACY_TOKEN_KEY = 'orca.remote.deviceToken'
const LEGACY_DEVICE_KEY = 'orca.remote.device'

function makeStore(initial: Record<string, string> = {}): KeyValueStore & { map: Map<string, string> } {
  const map = new Map<string, string>(Object.entries(initial))
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key)! : null),
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key)
  }
}

describe('remote storage keys — read fallback', () => {
  it('reads the canonical vertragus keys', () => {
    const store = makeStore({ [REMOTE_TOKEN_KEY]: 'tok', [REMOTE_DEVICE_KEY]: '{"id":"d1"}' })
    expect(readRemoteToken(store)).toBe('tok')
    expect(readRemoteDevice(store)).toBe('{"id":"d1"}')
  })

  it('falls back to legacy orca.remote.* keys for a paired pre-rebrand device', () => {
    const store = makeStore({ [LEGACY_TOKEN_KEY]: 'legacy-tok', [LEGACY_DEVICE_KEY]: '{"id":"old"}' })
    expect(readRemoteToken(store)).toBe('legacy-tok')
    expect(readRemoteDevice(store)).toBe('{"id":"old"}')
  })

  it('prefers the canonical value when both keys exist', () => {
    const store = makeStore({ [REMOTE_TOKEN_KEY]: 'new', [LEGACY_TOKEN_KEY]: 'old' })
    expect(readRemoteToken(store)).toBe('new')
  })

  it('returns empty string when unpaired — never invents a token', () => {
    const store = makeStore()
    expect(readRemoteToken(store)).toBe('')
    expect(readRemoteDevice(store)).toBe('')
    expect(store.map.size).toBe(0)
  })
})

describe('remote storage keys — write (no dual-storage leak)', () => {
  it('writes only the canonical key and drops the legacy duplicate', () => {
    const store = makeStore({ [LEGACY_TOKEN_KEY]: 'old', [LEGACY_DEVICE_KEY]: '{"id":"old"}' })
    writeRemoteToken(store, 'fresh')
    writeRemoteDevice(store, '{"id":"new"}')

    expect(store.map.get(REMOTE_TOKEN_KEY)).toBe('fresh')
    expect(store.map.get(REMOTE_DEVICE_KEY)).toBe('{"id":"new"}')
    // Secret material must not linger under the legacy key.
    expect(store.map.has(LEGACY_TOKEN_KEY)).toBe(false)
    expect(store.map.has(LEGACY_DEVICE_KEY)).toBe(false)
  })

  it('never writes into the legacy key namespace', () => {
    const store = makeStore()
    writeRemoteToken(store, 'fresh')
    expect(store.map.has(LEGACY_TOKEN_KEY)).toBe(false)
    expect([...store.map.keys()]).toEqual([REMOTE_TOKEN_KEY])
  })
})
