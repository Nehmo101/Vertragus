/**
 * Runtime validation for untrusted arguments that cross the
 * renderer -> bridge -> main boundary. A compromised renderer can invoke any
 * exposed channel with arbitrary payloads, so string identifiers are validated
 * for shape and bounds before a handler ever sees them. This complements the
 * main-process allow-lists (e.g. PUBLIC_CONFIG_*_KEYS) with an early, shared
 * guard that also runs inside the preload bridge.
 */

export class IpcValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IpcValidationError'
  }
}

/** Public config keys are bounded dotted identifiers such as `ui.theme`. */
const CONFIG_KEY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,126}[A-Za-z0-9])?$/

/**
 * Validate a `config:get` / `config:set` key. Rejects non-strings, empty or
 * whitespace-only keys, over-long keys and keys with unexpected characters
 * (path separators, control characters, prototype-pollution probes).
 */
export function assertValidConfigKey(key: unknown): string {
  if (typeof key !== 'string') {
    throw new IpcValidationError('Ungültiger Config-Schlüssel: keine Zeichenkette.')
  }
  const trimmed = key.trim()
  if (!CONFIG_KEY_PATTERN.test(trimmed)) {
    throw new IpcValidationError(`Ungültiger Config-Schlüssel: ${JSON.stringify(key)}`)
  }
  return trimmed
}
