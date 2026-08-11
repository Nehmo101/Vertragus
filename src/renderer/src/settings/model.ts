/**
 * Accelerator validation for the hide-all hotkey field.
 *
 * Electron's `globalShortcut.register` answers two very different failures with
 * the same silence-shaped result: a MALFORMED accelerator throws deep inside
 * Electron, and a TAKEN one returns false. Only the second is worth reaching
 * the OS for — the first is a typo, and a typo deserves an answer while the
 * user is still typing, not after a round trip that also unregisters the
 * working hotkey they had before.
 *
 * So this module is the cheap gate and the main process stays the authority:
 * anything this rejects never leaves the window, and anything it accepts is
 * still reported honestly if the OS says no (see `hideAllHotkeyError`).
 *
 * The key list follows Electron's accelerator documentation. Being a little
 * stricter than Electron is fine here; being looser is not, because the throw
 * on the other side is what this exists to prevent.
 */
import { SETTINGS_STRINGS } from './strings'

/** Everything Electron accepts to the LEFT of the final key. */
export const ACCELERATOR_MODIFIERS = [
  'command',
  'cmd',
  'control',
  'ctrl',
  'commandorcontrol',
  'cmdorctrl',
  'alt',
  'option',
  'altgr',
  'shift',
  'super',
  'meta'
] as const

/** Named keys; single characters and F-keys are handled separately. */
const NAMED_KEYS = new Set([
  'plus',
  'space',
  'tab',
  'capslock',
  'numlock',
  'scrolllock',
  'backspace',
  'delete',
  'insert',
  'return',
  'enter',
  'up',
  'down',
  'left',
  'right',
  'home',
  'end',
  'pageup',
  'pagedown',
  'escape',
  'esc',
  'printscreen',
  'volumeup',
  'volumedown',
  'volumemute',
  'medianexttrack',
  'mediaprevioustrack',
  'mediastop',
  'mediaplaypause',
  'numdec',
  'numadd',
  'numsub',
  'nummult',
  'numdiv'
])

/** Punctuation Electron accepts as a bare key. */
const PUNCTUATION = new Set([...'0123456789', ...')!@#$%^&*(:;+=<,_->.?/~`{]|\\}"\''])

function isKey(raw: string): boolean {
  const key = raw.toLowerCase()
  if (key.length === 1) return /[a-z]/.test(key) || PUNCTUATION.has(raw)
  if (/^f([1-9]|1\d|2[0-4])$/.test(key)) return true
  if (/^num[0-9]$/.test(key)) return true
  return NAMED_KEYS.has(key)
}

export type AcceleratorCheck = { ok: true } | { ok: false; reason: string }

/**
 * Is this a plausible GLOBAL accelerator?
 *
 * Stricter than Electron in one deliberate place: a global shortcut must carry
 * at least one modifier. `globalShortcut.register('K')` is legal and swallows
 * the K key in every application on the machine — a setting no one wants and
 * nobody would connect to this window afterwards.
 */
export function validateAccelerator(value: string): AcceleratorCheck {
  const text = value.trim()
  if (!text) return { ok: false, reason: SETTINGS_STRINGS.errors.hotkeyEmpty }

  const parts = text.split('+')
  // "Control+" and "Control++" both mean: the key is missing. The single
  // exception is a trailing "+" that IS the key, written as "Plus".
  const key = parts.pop() ?? ''
  if (!key) return { ok: false, reason: SETTINGS_STRINGS.errors.hotkeyNoKey }
  if (parts.length === 0) return { ok: false, reason: SETTINGS_STRINGS.errors.hotkeyNoModifier }

  const seen = new Set<string>()
  for (const part of parts) {
    const modifier = part.trim().toLowerCase()
    if (!(ACCELERATOR_MODIFIERS as readonly string[]).includes(modifier)) {
      return { ok: false, reason: SETTINGS_STRINGS.errors.hotkeyUnknownModifier(part) }
    }
    if (seen.has(modifier)) {
      return { ok: false, reason: SETTINGS_STRINGS.errors.hotkeyDuplicateModifier(part) }
    }
    seen.add(modifier)
  }

  if (!isKey(key)) return { ok: false, reason: SETTINGS_STRINGS.errors.hotkeyUnknownKey(key) }
  return { ok: true }
}
