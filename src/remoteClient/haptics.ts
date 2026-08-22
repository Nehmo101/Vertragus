/**
 * Tactile confirmation for the few phone actions that are irreversible or
 * easy to mis-tap (stopping a run, sending an answer, a control key in the
 * terminal). `navigator.vibrate` is absent on iOS and may be disabled by the
 * user everywhere, so every call is best-effort and never throws.
 *
 * Patterns stay short on purpose: a buzz longer than ~30 ms reads as an error
 * on Android, and the panel's own language is quiet.
 */

export type HapticKind = 'tap' | 'confirm' | 'warn'

const PATTERNS: Record<HapticKind, number | number[]> = {
  /** A key press or a chip tap. */
  tap: 8,
  /** Something was accepted and sent. */
  confirm: [12, 40, 12],
  /** A destructive action armed or fired. */
  warn: [20, 60, 20]
}

/**
 * Pure: the vibration pattern for one kind, so the mapping is testable
 * without a navigator.
 */
export function hapticPattern(kind: HapticKind): number | number[] {
  return PATTERNS[kind]
}

/** Fire one haptic. Silent no-op where the API or permission is missing. */
export function haptic(kind: HapticKind): void {
  // Called through `navigator`, not through a detached reference: the DOM lib
  // declares `vibrate` as an overload set, and a detached one collapses to the
  // `Iterable<number>` signature that a bare `number` does not satisfy.
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
  try {
    navigator.vibrate(hapticPattern(kind))
  } catch {
    /* A browser that rejects the pattern is not worth a crash. */
  }
}
