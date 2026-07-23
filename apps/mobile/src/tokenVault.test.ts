import { describe, expect, it } from 'vitest'
import {
  browserVaultEnv,
  loadRemoteToken,
  storeRemoteToken,
  VAULT_KEY_RECORD,
  VAULT_TOKEN_RECORD,
  type AsyncRecordStore,
  type TokenVaultEnv
} from './tokenVault'
import { REMOTE_TOKEN_KEY, type KeyValueStore } from './storageKeys'

const LEGACY_TOKEN_KEY = 'orca.remote.deviceToken'
const TOKEN = 'a'.repeat(48)

function kvStore(initial: Record<string, string> = {}): KeyValueStore & { map: Map<string, string> } {
  const map = new Map<string, string>(Object.entries(initial))
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key)! : null),
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key)
  }
}

function recordStore(): AsyncRecordStore & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>()
  return {
    map,
    get: (key) => Promise.resolve(map.get(key)),
    put: (key, value) => { map.set(key, value); return Promise.resolve() }
  }
}

/**
 * Vault environment backed by Node's WebCrypto and an in-memory record store,
 * mirroring the browser wiring without needing IndexedDB. Sharing `records`
 * across envs simulates the same device across app restarts.
 */
function vaultEnv(
  local: ReturnType<typeof kvStore> = kvStore(),
  records: ReturnType<typeof recordStore> = recordStore()
): TokenVaultEnv & { local: ReturnType<typeof kvStore>; records: ReturnType<typeof recordStore> } {
  return {
    subtle: crypto.subtle,
    getRandomValues: (array) => crypto.getRandomValues(array),
    openStore: () => Promise.resolve(records),
    local,
    records
  }
}

describe('tokenVault — encrypted round trip', () => {
  it('stores the token AES-GCM-encrypted in the record store, never in localStorage', async () => {
    const env = vaultEnv()
    await expect(storeRemoteToken(TOKEN, env)).resolves.toBe('vault')
    // localStorage stays empty — no plaintext copy anywhere.
    expect(env.local.map.size).toBe(0)
    const record = env.records.map.get(VAULT_TOKEN_RECORD) as { version: number; iv: Uint8Array; data: ArrayBuffer }
    expect(record.version).toBe(1)
    expect(record.iv).toBeInstanceOf(Uint8Array)
    expect(record.iv).toHaveLength(12)
    // The ciphertext must not contain the token in clear.
    expect(new TextDecoder().decode(record.data)).not.toContain(TOKEN)
    await expect(loadRemoteToken(env)).resolves.toBe(TOKEN)
  })

  it('generates the AES key as non-extractable and persists it in the record store', async () => {
    const env = vaultEnv()
    await storeRemoteToken(TOKEN, env)
    const key = env.records.map.get(VAULT_KEY_RECORD) as CryptoKey
    expect(key.type).toBe('secret')
    expect(key.extractable).toBe(false)
    // WebCrypto enforces non-extractability: export attempts must fail.
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow()
  })

  it('reuses the persisted key across writes instead of generating a new one', async () => {
    const env = vaultEnv()
    await storeRemoteToken(TOKEN, env)
    const firstKey = env.records.map.get(VAULT_KEY_RECORD)
    await storeRemoteToken('b'.repeat(48), env)
    expect(env.records.map.get(VAULT_KEY_RECORD)).toBe(firstKey)
    await expect(loadRemoteToken(env)).resolves.toBe('b'.repeat(48))
  })
})

describe('tokenVault — one-time localStorage migration', () => {
  it('migrates an existing plaintext token into the vault and purges localStorage', async () => {
    const records = recordStore()
    const firstRun = vaultEnv(kvStore({ [REMOTE_TOKEN_KEY]: TOKEN }), records)
    await expect(loadRemoteToken(firstRun)).resolves.toBe(TOKEN)
    expect(firstRun.local.map.has(REMOTE_TOKEN_KEY)).toBe(false)
    expect(records.map.has(VAULT_TOKEN_RECORD)).toBe(true)
    // Next app start: localStorage empty, token now served from the vault.
    const secondRun = vaultEnv(kvStore(), records)
    await expect(loadRemoteToken(secondRun)).resolves.toBe(TOKEN)
  })

  it('also purges a legacy orca.* plaintext token during migration', async () => {
    const env = vaultEnv(kvStore({ [LEGACY_TOKEN_KEY]: TOKEN }))
    await expect(loadRemoteToken(env)).resolves.toBe(TOKEN)
    expect(env.local.map.has(LEGACY_TOKEN_KEY)).toBe(false)
    await expect(loadRemoteToken(vaultEnv(kvStore(), env.records))).resolves.toBe(TOKEN)
  })

  it('lets a plaintext token win over a stale vault record, then migrates it', async () => {
    // Scenario: an old build re-paired and wrote localStorage after the vault
    // already held a previous token — the newer plaintext token must win.
    const records = recordStore()
    await storeRemoteToken('stale-vault-token-' + 'x'.repeat(30), vaultEnv(kvStore(), records))
    const env = vaultEnv(kvStore({ [REMOTE_TOKEN_KEY]: TOKEN }), records)
    await expect(loadRemoteToken(env)).resolves.toBe(TOKEN)
    expect(env.local.map.size).toBe(0)
    await expect(loadRemoteToken(vaultEnv(kvStore(), records))).resolves.toBe(TOKEN)
  })
})

describe('tokenVault — fallback behaviour', () => {
  it('falls back to localStorage only when WebCrypto is unavailable', async () => {
    const local = kvStore()
    const env: TokenVaultEnv = { ...vaultEnv(local), subtle: undefined }
    await expect(storeRemoteToken(TOKEN, env)).resolves.toBe('localStorage')
    expect(local.map.get(REMOTE_TOKEN_KEY)).toBe(TOKEN)
    await expect(loadRemoteToken(env)).resolves.toBe(TOKEN)
  })

  it('falls back to localStorage when IndexedDB cannot be opened', async () => {
    const local = kvStore()
    const env: TokenVaultEnv = {
      ...vaultEnv(local),
      openStore: () => Promise.reject(new Error('privater Modus'))
    }
    await expect(storeRemoteToken(TOKEN, env)).resolves.toBe('localStorage')
    expect(local.map.get(REMOTE_TOKEN_KEY)).toBe(TOKEN)
    await expect(loadRemoteToken(env)).resolves.toBe(TOKEN)
  })

  it('falls back to localStorage when the vault write itself fails', async () => {
    const local = kvStore()
    const records = recordStore()
    const broken: AsyncRecordStore = {
      get: records.get,
      put: () => Promise.reject(new Error('quota'))
    }
    const env: TokenVaultEnv = { ...vaultEnv(local, records), openStore: () => Promise.resolve(broken) }
    // A fresh pairing must never be lost, even at the cost of weaker storage.
    await expect(storeRemoteToken(TOKEN, env)).resolves.toBe('localStorage')
    expect(local.map.get(REMOTE_TOKEN_KEY)).toBe(TOKEN)
  })

  it('treats an undecryptable vault record as unpaired instead of throwing', async () => {
    const env = vaultEnv()
    await storeRemoteToken(TOKEN, env)
    const record = env.records.map.get(VAULT_TOKEN_RECORD) as { data: ArrayBuffer }
    // Corrupt the ciphertext: AES-GCM authentication must fail on read.
    env.records.map.set(VAULT_TOKEN_RECORD, { version: 1, iv: new Uint8Array(12), data: record.data })
    await expect(loadRemoteToken(env)).resolves.toBe('')
  })

  it('ignores a malformed vault record shape', async () => {
    const env = vaultEnv()
    env.records.map.set(VAULT_TOKEN_RECORD, { version: 2, nonsense: true })
    await expect(loadRemoteToken(env)).resolves.toBe('')
  })
})

describe('tokenVault — browser env wiring in a browserless runtime', () => {
  it('browserVaultEnv never throws and load resolves to empty without IndexedDB', async () => {
    // Node has WebCrypto but no IndexedDB/localStorage: the env must degrade
    // gracefully (memory store + no vault) instead of crashing at startup.
    const env = browserVaultEnv()
    expect(env.openStore).toBeUndefined()
    await expect(loadRemoteToken(env)).resolves.toBe('')
  })
})
