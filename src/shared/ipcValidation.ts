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
 * Dot-separated segments that must never appear in a config key: these are the
 * JavaScript prototype-pollution vectors. The shape pattern already blocks a
 * leading `__proto__`, but it happily accepts them mid-key (`ui.__proto__.x`)
 * or as bare `constructor` / `prototype`, so they are rejected explicitly.
 */
const FORBIDDEN_KEY_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * Validate a `config:get` / `config:set` key. Rejects non-strings, empty or
 * whitespace-only keys, over-long keys and keys with unexpected characters
 * (path separators, control characters, prototype-pollution probes).
 */
/**
 * Validate a required string identifier argument (profile id, task id, path,
 * branch, …) crossing the IPC boundary: non-empty, bounded, a real string.
 * The message shape matches the established workspace-session controller.
 */
export function assertIpcId(value: unknown, label: string, maxLength = 256): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    throw new IpcValidationError(`Ungültige ${label} (invalid payload).`)
  }
  return value
}

/** Like {@link assertIpcId}, but `undefined` passes through untouched. */
export function assertIpcOptionalId(
  value: unknown,
  label: string,
  maxLength = 256
): string | undefined {
  if (value === undefined) return undefined
  return assertIpcId(value, label, maxLength)
}

export function assertValidConfigKey(key: unknown): string {
  if (typeof key !== 'string') {
    throw new IpcValidationError('Ungültiger Config-Schlüssel: keine Zeichenkette.')
  }
  const trimmed = key.trim()
  if (!CONFIG_KEY_PATTERN.test(trimmed)) {
    throw new IpcValidationError(`Ungültiger Config-Schlüssel: ${JSON.stringify(key)}`)
  }
  if (trimmed.split('.').some((segment) => FORBIDDEN_KEY_SEGMENTS.has(segment))) {
    throw new IpcValidationError(`Ungültiger Config-Schlüssel: ${JSON.stringify(key)}`)
  }
  return trimmed
}
