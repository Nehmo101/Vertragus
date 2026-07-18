import type { ShortcutActionId, ShortcutBinding, ShortcutModifier, ShortcutPlatform } from './types'

export const DEFAULT_SHORTCUT_BINDINGS: Readonly<Record<ShortcutActionId, readonly ShortcutBinding[]>> = {
  'speech.toggle': [{ key: 'm', modifiers: ['Mod', 'Shift'] }]
}

const MODIFIER_ORDER: readonly Exclude<ShortcutModifier, 'Mod'>[] = [
  'Control',
  'Meta',
  'Alt',
  'Shift'
]

export function detectShortcutPlatform(platform = globalThis.navigator?.platform ?? ''): ShortcutPlatform {
  return /Mac|iPhone|iPad|iPod/i.test(platform) ? 'mac' : 'other'
}

export function normalizeShortcutKey(key: string): string {
  if (key === ' ') return 'space'
  return key.toLowerCase()
}

export function normalizeBinding(
  binding: ShortcutBinding,
  platform: ShortcutPlatform = detectShortcutPlatform()
): string {
  const modifiers = new Set<Exclude<ShortcutModifier, 'Mod'>>(
    (binding.modifiers ?? []).map((modifier) =>
      modifier === 'Mod' ? (platform === 'mac' ? 'Meta' : 'Control') : modifier
    ) as Exclude<ShortcutModifier, 'Mod'>[]
  )
  const ordered = MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier))
  return [...ordered, normalizeShortcutKey(binding.key)].join('+')
}

export function normalizeKeyboardEvent(event: KeyboardEvent): string {
  const modifiers: ShortcutModifier[] = []
  if (event.ctrlKey) modifiers.push('Control')
  if (event.metaKey) modifiers.push('Meta')
  if (event.altKey) modifiers.push('Alt')
  if (event.shiftKey) modifiers.push('Shift')
  return [...modifiers, normalizeShortcutKey(event.key)].join('+')
}
