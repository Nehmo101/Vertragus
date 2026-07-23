import { describe, expect, it } from 'vitest'
import { DeviceAuth, deviceAuthInternals } from './deviceAuth'
import { EncryptedDeviceStore, type DeviceRecordStore, type StoredDeviceRecord } from './deviceStore'

class MemoryStore implements DeviceRecordStore {
  records: StoredDeviceRecord[] = []
  load(): StoredDeviceRecord[] { return this.records.map((record) => ({ ...record, capabilities: [...record.capabilities] })) }
  save(records: StoredDeviceRecord[]): void { this.records = records.map((record) => ({ ...record, capabilities: [...record.capabilities] })) }
}

describe('DeviceAuth', () => {
  it('mints unique 256-bit tokens and persists only their sha256 digest', () => {
    const store = new MemoryStore()
    const auth = new DeviceAuth(store)
    const first = auth.pair(auth.startPairing().code, 'Telefon A')!
    const second = auth.pair(auth.startPairing().code, 'Telefon B')!

    expect(Buffer.from(first.token, 'base64url')).toHaveLength(32)
    expect(first.token).not.toBe(second.token)
    expect(JSON.stringify(store.records)).not.toContain(first.token)
    expect(store.records[0]?.tokenHash).toMatch(/^[a-f0-9]{64}$/)
    expect(auth.authenticate(first.token)?.id).toBe(first.device.id)
    expect(auth.authenticate(`${first.token}x`)).toBeUndefined()
  })

  it('rejects expired and replayed pairing codes and revoked devices', () => {
    let at = 1_000
    const store = new MemoryStore()
    const auth = new DeviceAuth(store, () => at)
    const expired = auth.startPairing()
    at += deviceAuthInternals.PAIRING_TTL_MS + 1
    expect(auth.pair(expired.code, 'Alt')).toBeUndefined()

    const challenge = auth.startPairing()
    const paired = auth.pair(challenge.code, 'Neu')!
    expect(auth.pair(challenge.code, 'Replay')).toBeUndefined()
    expect(auth.revoke(paired.device.id)).toBe(true)
    expect(auth.authenticate(paired.token)).toBeUndefined()
  })

  it('keeps every routed capability pairable — provider-fallback included', () => {
    const store = new MemoryStore()
    const auth = new DeviceAuth(store)
    const paired = auth.pair(
      auth.startPairing(['read', 'provider-fallback', 'nonsense' as never]).code,
      'Fallback-Gerät'
    )!
    expect(paired.device.capabilities).toEqual(['read', 'provider-fallback'])
  })

  it('encrypts the hash-only record and refuses a plaintext fallback', () => {
    let persisted: unknown
    const encrypted = new EncryptedDeviceStore(
      { available: () => true, encrypt: (value) => `enc:${value}`, decrypt: (value) => value.slice(4) },
      () => typeof persisted === 'string' ? persisted : undefined,
      (_key, value) => { persisted = value }
    )
    const auth = new DeviceAuth(encrypted)
    const challenge = auth.startPairing()
    const paired = auth.pair(challenge.code, 'Hash only')!
    expect(String(persisted)).toContain('enc:')
    expect(String(persisted)).not.toContain(paired.token)

    const unavailable = new EncryptedDeviceStore(
      { available: () => false, encrypt: String, decrypt: String },
      () => undefined,
      () => undefined
    )
    expect(() => unavailable.save([])).toThrow(/safeStorage/)
  })
})

