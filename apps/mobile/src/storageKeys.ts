/**
 * localStorage keys for the mobile remote session. After the Vertragus rebrand
 * the canonical prefix is `vertragus.remote.*`; the legacy `orca.remote.*` keys
 * are still read as a one-way fallback so a paired device survives the upgrade.
 * Writes go only to the canonical key and drop any legacy duplicate, so the
 * pairing token is never mirrored into two places.
 *
 * Kept free of DOM globals (takes a KeyValueStore) so the fallback/no-leak
 * behaviour is unit-testable without a browser.
 */
export interface KeyValueStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export const REMOTE_TOKEN_KEY = 'vertragus.remote.deviceToken'
export const REMOTE_DEVICE_KEY = 'vertragus.remote.device'
const LEGACY_REMOTE_TOKEN_KEY = 'orca.remote.deviceToken'
const LEGACY_REMOTE_DEVICE_KEY = 'orca.remote.device'

/**
 * Read the canonical value, falling back to the legacy key. Returns `''` when
 * neither is present — an unpaired device must never surface an invented token.
 */
function readWithFallback(store: KeyValueStore, key: string, legacyKey: string): string {
  return store.getItem(key) ?? store.getItem(legacyKey) ?? ''
}

/** Persist under the canonical key and remove any legacy duplicate (no dual storage). */
function writeCanonical(
  store: KeyValueStore,
  key: string,
  legacyKey: string,
  value: string
): void {
  store.setItem(key, value)
  if (store.getItem(legacyKey) !== null) store.removeItem(legacyKey)
}

export function readRemoteToken(store: KeyValueStore): string {
  return readWithFallback(store, REMOTE_TOKEN_KEY, LEGACY_REMOTE_TOKEN_KEY)
}

export function readRemoteDevice(store: KeyValueStore): string {
  return readWithFallback(store, REMOTE_DEVICE_KEY, LEGACY_REMOTE_DEVICE_KEY)
}

export function writeRemoteToken(store: KeyValueStore, token: string): void {
  writeCanonical(store, REMOTE_TOKEN_KEY, LEGACY_REMOTE_TOKEN_KEY, token)
}

export function writeRemoteDevice(store: KeyValueStore, deviceJson: string): void {
  writeCanonical(store, REMOTE_DEVICE_KEY, LEGACY_REMOTE_DEVICE_KEY, deviceJson)
}
