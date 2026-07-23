import { describe, expect, it, beforeEach, vi } from 'vitest'
import type { SecretCodec } from './deviceStore'
import {
  clearApnsCredential,
  readApnsCredential,
  readApnsTokens,
  writeApnsCredential,
  writeApnsTokens,
  type StoredApnsToken
} from './deviceStore'

// In-memory stand-in for the electron-store settings bag.
const { store } = vi.hoisted(() => ({ store: new Map<string, unknown>() }))
vi.mock('@main/config/store', () => ({
  getSetting: (key: string) => store.get(key),
  setSetting: (key: string, value: unknown) => {
    if (value === undefined) store.delete(key)
    else store.set(key, value)
  }
}))

// Passthrough codec so we test the (de)serialization + validation, not safeStorage itself.
const codec: SecretCodec = { available: () => true, encrypt: (value) => value, decrypt: (value) => value }
const unavailable: SecretCodec = { available: () => false, encrypt: (v) => v, decrypt: (v) => v }

function token(overrides: Partial<StoredApnsToken> = {}): StoredApnsToken {
  return {
    id: 'id-1', deviceId: 'device-1', token: 'a'.repeat(64),
    environment: 'production', bundleId: 'com.example.App', createdAt: 1, ...overrides
  }
}

beforeEach(() => store.clear())

describe('APNs token storage', () => {
  it('round-trips valid tokens', () => {
    const tokens = [token(), token({ id: 'id-2', token: 'b'.repeat(80), environment: 'sandbox' })]
    writeApnsTokens(tokens, codec)
    expect(readApnsTokens(codec)).toEqual(tokens)
  })

  it('defensively drops malformed entries', () => {
    store.set('secrets.remote.apnsTokens', JSON.stringify([
      token(),
      { ...token({ id: 'bad-token' }), token: 'nothex!' },
      { ...token({ id: 'bad-env' }), environment: 'staging' },
      { ...token({ id: 'no-bundle' }), bundleId: '' },
      { id: 'missing-fields' },
      null,
      'garbage'
    ]))
    expect(readApnsTokens(codec).map((entry) => entry.id)).toEqual(['id-1'])
  })

  it('returns an empty list when the codec is unavailable', () => {
    writeApnsTokens([token()], codec)
    expect(readApnsTokens(unavailable)).toEqual([])
  })
})

describe('APNs credential storage', () => {
  const credential = {
    teamId: 'TEAM123456', keyId: 'KEY1234567',
    p8: '-----BEGIN PRIVATE KEY-----\nMIG...\n-----END PRIVATE KEY-----',
    bundleId: 'com.example.App', environment: 'production' as const
  }

  it('round-trips a credential including the p8 key', () => {
    writeApnsCredential(credential, codec)
    expect(readApnsCredential(codec)).toEqual(credential)
  })

  it('trims fields on write', () => {
    writeApnsCredential({ ...credential, teamId: '  TEAM123456  ', bundleId: ' com.example.App ' }, codec)
    const stored = readApnsCredential(codec)!
    expect(stored.teamId).toBe('TEAM123456')
    expect(stored.bundleId).toBe('com.example.App')
  })

  it('rejects incomplete credentials and unavailable encryption', () => {
    expect(() => writeApnsCredential({ ...credential, teamId: '   ' }, codec)).toThrow(/erforderlich/)
    expect(() => writeApnsCredential(credential, unavailable)).toThrow(/safeStorage/)
  })

  it('clears the stored credential', () => {
    writeApnsCredential(credential, codec)
    clearApnsCredential()
    expect(readApnsCredential(codec)).toBeUndefined()
  })
})
