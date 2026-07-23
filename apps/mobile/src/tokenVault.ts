/**
 * Hardened at-rest storage for the remote device bearer token.
 *
 * localStorage keeps secrets as plaintext that any XSS payload or storage dump
 * can read wholesale. The vault instead stores the token AES-GCM-encrypted in
 * IndexedDB; the encryption key is generated as a *non-extractable* WebCrypto
 * key (`extractable: false`) and itself persisted only via IndexedDB's
 * structured clone. An injected script can still use the key while running,
 * but can never export it, and offline storage dumps only contain ciphertext —
 * the standard best practice for PWAs without a backend session.
 *
 * On load, an existing plaintext localStorage token (written by older builds,
 * canonical or legacy key) is migrated into the vault once and deleted from
 * localStorage. Plaintext localStorage remains only as a last-resort fallback
 * when WebCrypto or IndexedDB are unavailable (e.g. some private-browsing
 * modes) — losing a fresh pairing would be worse than the weaker storage.
 *
 * Kept injectable (crypto/store/localStorage as `TokenVaultEnv`) so migration,
 * fallback and round-trip behaviour are unit-testable without a browser.
 */
import {
  purgeRemoteToken,
  readRemoteToken,
  writeRemoteToken,
  type KeyValueStore
} from './storageKeys'

/** Minimal async record surface; backed by IndexedDB in the browser. */
export interface AsyncRecordStore {
  get(key: string): Promise<unknown>
  put(key: string, value: unknown): Promise<void>
}

export interface TokenVaultEnv {
  /** WebCrypto implementation; missing (insecure context) → plaintext fallback. */
  subtle?: SubtleCrypto
  getRandomValues?(array: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer>
  /** Opens the persistent record store; missing or failing → plaintext fallback. */
  openStore?(): Promise<AsyncRecordStore>
  /** Plaintext fallback target and one-time migration source. */
  local: KeyValueStore
}

export type TokenVaultBackend = 'vault' | 'localStorage'

const VAULT_DB_NAME = 'vertragus.remote.vault'
const VAULT_DB_VERSION = 1
const VAULT_OBJECT_STORE = 'secrets'
export const VAULT_KEY_RECORD = 'deviceToken.key'
export const VAULT_TOKEN_RECORD = 'deviceToken.ciphertext'
const AES_GCM_IV_BYTES = 12

interface EncryptedTokenRecord {
  version: 1
  iv: Uint8Array<ArrayBuffer>
  data: ArrayBuffer
}

function requestPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB-Anfrage fehlgeschlagen.'))
  })
}

/** Thin IndexedDB adapter for the vault database (single key/value store). */
export function openIndexedDbVault(factory: IDBFactory): Promise<AsyncRecordStore> {
  return new Promise((resolve, reject) => {
    const open = factory.open(VAULT_DB_NAME, VAULT_DB_VERSION)
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(VAULT_OBJECT_STORE)) {
        open.result.createObjectStore(VAULT_OBJECT_STORE)
      }
    }
    open.onerror = () => reject(open.error ?? new Error('IndexedDB nicht verfügbar.'))
    open.onblocked = () => reject(new Error('IndexedDB ist blockiert.'))
    open.onsuccess = () => {
      const db = open.result
      const run = <T>(
        mode: IDBTransactionMode,
        operation: (store: IDBObjectStore) => IDBRequest<T>
      ): Promise<T> =>
        requestPromise(operation(db.transaction(VAULT_OBJECT_STORE, mode).objectStore(VAULT_OBJECT_STORE)))
      resolve({
        get: (key) => run('readonly', (store) => store.get(key)),
        put: async (key, value) => { await run('readwrite', (store) => store.put(value, key)) }
      })
    }
  })
}

function memoryStore(): KeyValueStore {
  const map = new Map<string, string>()
  return {
    getItem: (key) => (map.has(key) ? map.get(key)! : null),
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key)
  }
}

/** Environment wiring from browser globals; every capability is feature-detected. */
export function browserVaultEnv(): TokenVaultEnv {
  const cryptoApi = typeof crypto === 'undefined' ? undefined : crypto
  let local: KeyValueStore
  try {
    // Accessing localStorage itself can throw (privacy modes); degrade to an
    // in-memory store so the app never crashes on startup.
    local = typeof localStorage === 'undefined' ? memoryStore() : localStorage
  } catch {
    local = memoryStore()
  }
  return {
    subtle: cryptoApi?.subtle,
    getRandomValues: cryptoApi ? (array) => cryptoApi.getRandomValues(array) : undefined,
    openStore: typeof indexedDB === 'undefined' ? undefined : () => openIndexedDbVault(indexedDB),
    local
  }
}

interface OpenVault {
  subtle: SubtleCrypto
  getRandomValues(array: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer>
  store: AsyncRecordStore
}

async function openVault(env: TokenVaultEnv): Promise<OpenVault | undefined> {
  const { subtle, getRandomValues, openStore } = env
  if (!subtle || !getRandomValues || !openStore) return undefined
  try {
    return { subtle, getRandomValues, store: await openStore() }
  } catch {
    // IndexedDB can be present but unusable (e.g. private browsing); fall back.
    return undefined
  }
}

function looksLikeCryptoKey(value: unknown): value is CryptoKey {
  return typeof value === 'object' && value !== null &&
    'algorithm' in value && 'usages' in value && 'type' in value
}

function looksLikeEncryptedRecord(value: unknown): value is EncryptedTokenRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Partial<EncryptedTokenRecord>
  return record.version === 1 && record.iv instanceof Uint8Array && record.data instanceof ArrayBuffer
}

async function vaultKey(vault: OpenVault): Promise<CryptoKey> {
  const existing = await vault.store.get(VAULT_KEY_RECORD)
  if (looksLikeCryptoKey(existing)) return existing
  // extractable:false — scripts (including injected ones) can use the key at
  // runtime but can never export or exfiltrate the raw key material.
  const key = await vault.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
  await vault.store.put(VAULT_KEY_RECORD, key)
  return key
}

async function encryptToken(vault: OpenVault, token: string): Promise<void> {
  const key = await vaultKey(vault)
  const iv = vault.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES))
  const data = await vault.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(token))
  const record: EncryptedTokenRecord = { version: 1, iv, data }
  await vault.store.put(VAULT_TOKEN_RECORD, record)
}

async function decryptToken(vault: OpenVault): Promise<string> {
  const record = await vault.store.get(VAULT_TOKEN_RECORD)
  if (!looksLikeEncryptedRecord(record)) return ''
  const key = await vaultKey(vault)
  const plain = await vault.subtle.decrypt({ name: 'AES-GCM', iv: record.iv }, key, record.data)
  return new TextDecoder().decode(plain)
}

/**
 * Load the remote bearer token. A plaintext localStorage token (older build or
 * an earlier fallback write) wins and is migrated into the vault exactly once,
 * with all plaintext copies deleted; otherwise the encrypted vault record is
 * decrypted. Never throws — a broken vault yields `''` so the app shows the
 * pairing screen instead of crashing.
 */
export async function loadRemoteToken(env: TokenVaultEnv = browserVaultEnv()): Promise<string> {
  const vault = await openVault(env)
  const plaintext = readRemoteToken(env.local)
  if (!vault) return plaintext
  if (plaintext) {
    try {
      await encryptToken(vault, plaintext)
      purgeRemoteToken(env.local)
    } catch { /* Keep the session usable; migration retries on the next load. */ }
    return plaintext
  }
  try {
    return await decryptToken(vault)
  } catch {
    // Undecryptable record (cleared key, corrupt data): treat as unpaired.
    return ''
  }
}

/**
 * Persist the token after pairing. Prefers the encrypted vault and removes any
 * plaintext copies; falls back to localStorage only when WebCrypto/IndexedDB
 * are unavailable or the vault write fails — a fresh pairing must never be
 * lost. Returns which backend actually stored the token.
 */
export async function storeRemoteToken(
  token: string,
  env: TokenVaultEnv = browserVaultEnv()
): Promise<TokenVaultBackend> {
  const vault = await openVault(env)
  if (vault) {
    try {
      await encryptToken(vault, token)
      purgeRemoteToken(env.local)
      return 'vault'
    } catch { /* Fall through to the plaintext fallback below. */ }
  }
  writeRemoteToken(env.local, token)
  return 'localStorage'
}
