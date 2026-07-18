import {
  DEFAULT_SHORTCUT_BINDINGS,
  detectShortcutPlatform,
  normalizeBinding,
  normalizeKeyboardEvent
} from './bindings'
import { shouldIgnoreShortcutEvent } from './eventGate'
import type {
  ShortcutActionId,
  ShortcutBinding,
  ShortcutPlatform,
  ShortcutRegistration
} from './types'

export type ShortcutBindings = Readonly<Partial<Record<ShortcutActionId, readonly ShortcutBinding[]>>>

export interface ShortcutRegistryOptions {
  bindings?: ShortcutBindings
  platform?: ShortcutPlatform
}

interface RegisteredShortcut extends ShortcutRegistration {
  order: number
}

export class ShortcutRegistry {
  private readonly registrations = new Set<RegisteredShortcut>()
  private readonly activeContexts = new Set<string>()
  private bindings: ShortcutBindings
  private readonly platform: ShortcutPlatform
  private nextOrder = 0

  constructor(options: ShortcutRegistryOptions = {}) {
    this.bindings = options.bindings ?? DEFAULT_SHORTCUT_BINDINGS
    this.platform = options.platform ?? detectShortcutPlatform()
  }

  register(registration: ShortcutRegistration): () => void {
    const entry = { ...registration, order: this.nextOrder++ }
    this.registrations.add(entry)
    return () => this.registrations.delete(entry)
  }

  setBindings(bindings: ShortcutBindings): void {
    this.bindings = bindings
  }

  setContextActive(context: string, active: boolean): void {
    if (active) this.activeContexts.add(context)
    else this.activeContexts.delete(context)
  }

  handleKeydown = (event: KeyboardEvent): boolean => {
    if (shouldIgnoreShortcutEvent(event)) return false
    const eventCombination = normalizeKeyboardEvent(event)
    const actions = Object.entries(this.bindings)
      .filter(([, bindings]) =>
        bindings?.some((binding) => normalizeBinding(binding, this.platform) === eventCombination)
      )
      .map(([actionId]) => actionId as ShortcutActionId)

    const match = [...this.registrations]
      .filter(
        (registration) =>
          actions.includes(registration.actionId) &&
          (!registration.context || this.activeContexts.has(registration.context)) &&
          (registration.isActive?.() ?? true)
      )
      .sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0) || right.order - left.order)[0]

    if (!match) return false
    const handled = match.handler({ actionId: match.actionId, event }) !== false
    if (handled) event.preventDefault()
    return handled
  }

  attach(target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>): () => void {
    const listener: EventListener = (event) => this.handleKeydown(event as KeyboardEvent)
    target.addEventListener('keydown', listener)
    return () => target.removeEventListener('keydown', listener)
  }
}
