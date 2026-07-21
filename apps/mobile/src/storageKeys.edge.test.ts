import { describe, expect, it, vi } from 'vitest'
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

/**
 * A Map-backed KeyValueStore whose mutators are vi.fn spies, so tests can assert
 * not only the resulting state but also *which* operations were issued (e.g. that
 * a legacy key is never touched when it was absent — no spurious removeItem).
 */
function makeStore(initial: Record<string, string> = {}): KeyValueStore & {
  map: Map<string, string>
  setItem: ReturnType<typeof vi.fn>
  removeItem: ReturnType<typeof vi.fn>
} {
  const map = new Map<string, string>(Object.entries(initial))
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key)! : null),
    setItem: vi.fn((key: string, value: string) => void map.set(key, value)),
    removeItem: vi.fn((key: string) => void map.delete(key))
  }
}

describe('remote storage keys — read fallback subtleties', () => {
  it('prefers the canonical device value when both keys exist', () => {
    // Existing suite proves this for the token; lock the same for the device blob.
    const store = makeStore({
      [REMOTE_DEVICE_KEY]: '{"id":"new"}',
      [LEGACY_DEVICE_KEY]: '{"id":"old"}'
    })
    expect(readRemoteDevice(store)).toBe('{"id":"new"}')
  })

  it('an empty-string canonical value suppresses the legacy fallback', () => {
    // `getItem(canonical)` returns '' (not null), so `??` must NOT reach the legacy
    // key. A future switch to `||` would regress this into leaking a stale token.
    const store = makeStore({
      [REMOTE_TOKEN_KEY]: '',
      [LEGACY_TOKEN_KEY]: 'stale-legacy'
    })
    expect(readRemoteToken(store)).toBe('')
  })

  it('falls back to legacy only when the canonical key is entirely absent', () => {
    const store = makeStore({ [LEGACY_TOKEN_KEY]: 'legacy-only' })
    expect(readRemoteToken(store)).toBe('legacy-only')
  })
})

describe('remote storage keys — write side effects', () => {
  it('does not issue a removeItem when there is no legacy duplicate to drop', () => {
    const store = makeStore()
    writeRemoteToken(store, 'fresh')
    expect(store.setItem).toHaveBeenCalledWith(REMOTE_TOKEN_KEY, 'fresh')
    expect(store.removeItem).not.toHaveBeenCalled()
  })

  it('removes exactly the legacy key (and only it) when migrating', () => {
    const store = makeStore({ [LEGACY_TOKEN_KEY]: 'old' })
    writeRemoteToken(store, 'fresh')
    expect(store.removeItem).toHaveBeenCalledTimes(1)
    expect(store.removeItem).toHaveBeenCalledWith(LEGACY_TOKEN_KEY)
  })

  it('overwrites an existing canonical value in place', () => {
    const store = makeStore({ [REMOTE_TOKEN_KEY]: 'first' })
    writeRemoteToken(store, 'second')
    expect(store.map.get(REMOTE_TOKEN_KEY)).toBe('second')
    expect(store.map.size).toBe(1)
  })

  it('keeps the token and device namespaces independent', () => {
    const store = makeStore()
    writeRemoteToken(store, 'tok')
    writeRemoteDevice(store, '{"id":"d1"}')
    // Writing the device must not disturb the token, and vice versa.
    expect(store.map.get(REMOTE_TOKEN_KEY)).toBe('tok')
    expect(store.map.get(REMOTE_DEVICE_KEY)).toBe('{"id":"d1"}')
    expect([...store.map.keys()].sort()).toEqual([REMOTE_DEVICE_KEY, REMOTE_TOKEN_KEY].sort())
  })
})

describe('remote storage keys — round trip', () => {
  it('a written token/device is read back canonically after legacy migration', () => {
    const store = makeStore({ [LEGACY_TOKEN_KEY]: 'old', [LEGACY_DEVICE_KEY]: '{"id":"old"}' })
    writeRemoteToken(store, 'rt-token')
    writeRemoteDevice(store, '{"id":"rt"}')
    expect(readRemoteToken(store)).toBe('rt-token')
    expect(readRemoteDevice(store)).toBe('{"id":"rt"}')
    expect(store.map.has(LEGACY_TOKEN_KEY)).toBe(false)
    expect(store.map.has(LEGACY_DEVICE_KEY)).toBe(false)
  })
})
