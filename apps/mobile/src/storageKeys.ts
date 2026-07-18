/**
 * Persistent PWA keys. Canonical Vertragus names are written going forward;
 * legacy orca.* keys are still read so already-paired devices keep working.
 */
export const DEVICE_TOKEN_KEY = 'vertragus.remote.deviceToken'
export const DEVICE_INFO_KEY = 'vertragus.remote.device'

/** @deprecated Pre-rebrand localStorage keys; read-only fallback. */
export const LEGACY_DEVICE_TOKEN_KEY = 'orca.remote.deviceToken'
/** @deprecated Pre-rebrand localStorage keys; read-only fallback. */
export const LEGACY_DEVICE_INFO_KEY = 'orca.remote.device'

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem?(key: string): void
}

export function readDeviceToken(storage: StorageLike): string {
  return storage.getItem(DEVICE_TOKEN_KEY) ?? storage.getItem(LEGACY_DEVICE_TOKEN_KEY) ?? ''
}

export function readDeviceInfoJson(storage: StorageLike): string {
  return storage.getItem(DEVICE_INFO_KEY) ?? storage.getItem(LEGACY_DEVICE_INFO_KEY) ?? ''
}

export function writeDeviceSession(
  storage: StorageLike,
  token: string,
  deviceJson: string
): void {
  storage.setItem(DEVICE_TOKEN_KEY, token)
  storage.setItem(DEVICE_INFO_KEY, deviceJson)
  // Drop legacy duplicates after a successful write so tokens are not kept twice.
  storage.removeItem?.(LEGACY_DEVICE_TOKEN_KEY)
  storage.removeItem?.(LEGACY_DEVICE_INFO_KEY)
}
