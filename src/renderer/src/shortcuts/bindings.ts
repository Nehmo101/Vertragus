import type { ShortcutActionId, ShortcutBinding, ShortcutModifier, ShortcutPlatform } from './types'

/**
 * `agents.stopAll` (Mod+Shift+.) läuft NICHT direkt auf `stopAll()`: Der
 * Bestätigungs-Dialog lebt weiterhin als lokaler Komponenten-State
 * (`confirmKill`) in TitleBar.tsx. Der Shortcut ruft `requestStopAll()` im
 * agentsSlice; die TitleBar beobachtet `stopAllRequestId` und öffnet daraufhin
 * ihren bestehenden Confirm-Flow — so bleibt die Rückfrage garantiert erhalten.
 */
export const DEFAULT_SHORTCUT_BINDINGS: Readonly<Record<ShortcutActionId, readonly ShortcutBinding[]>> = {
  'speech.toggle': [{ key: 'm', modifiers: ['Mod', 'Shift'] }],
  'nav.workspace': [{ key: '1', modifiers: ['Mod'] }],
  'nav.inbox': [{ key: '2', modifiers: ['Mod'] }],
  'nav.approvals': [{ key: '3', modifiers: ['Mod'] }],
  'nav.changes': [{ key: '4', modifiers: ['Mod'] }],
  'layout.canvas': [{ key: '1', modifiers: ['Mod', 'Alt'] }],
  'layout.tiles': [{ key: '2', modifiers: ['Mod', 'Alt'] }],
  'layout.focus': [{ key: '3', modifiers: ['Mod', 'Alt'] }],
  'agents.startAll': [{ key: 'Enter', modifiers: ['Mod', 'Shift'] }],
  'agents.stopAll': [{ key: '.', modifiers: ['Mod', 'Shift'] }],
  'panel.sidebarLeft': [{ key: 'b', modifiers: ['Mod'] }],
  'panel.orchestratorRight': [{ key: 'b', modifiers: ['Mod', 'Alt'] }]
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
