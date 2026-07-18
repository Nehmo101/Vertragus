/**
 * Regression matrix for the app-local shortcut dispatcher (Ctrl/Cmd+Shift+M → speech.toggle).
 *
 * Export assumptions (Integrator may rename files; keep `./index` barrel stable):
 * - `DEFAULT_SHORTCUT_BINDINGS['speech.toggle']` → `[{ key: 'm', modifiers: ['Mod', 'Shift'] }]`
 * - `normalizeBinding(binding, 'other'|'mac')` → `'Control+Shift+m'` / `'Meta+Shift+m'`
 * - `shouldIgnoreShortcutEvent(event)` → true for repeat, IME (`isComposing` / keyCode 229),
 *   defaultPrevented, and editable targets (input/textarea/select/contenteditable via composedPath)
 * - `new ShortcutRegistry({ platform?, bindings? })`
 * - `registry.register({ actionId, handler, context?, priority? })` → unregister `() => void`
 * - `registry.setContextActive(context, active)` — contextual handlers only when active
 * - `registry.handleKeydown(event)` → boolean; `preventDefault` only when handler !== false
 * - `registry.attach(target)` → detach `() => void` (removes keydown listener)
 *
 * Combined stand: production ships `bindings.ts` + `eventGate.ts` + `registry.ts` + `types.ts` + `index.ts`;
 * the `./index` barrel re-exports the dispatcher contract this suite pins.
 */
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SHORTCUT_BINDINGS, normalizeBinding, ShortcutRegistry, shouldIgnoreShortcutEvent } from './index'

function keyboardEvent(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  const preventDefault = vi.fn()
  return {
    key: 'm',
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: true,
    repeat: false,
    isComposing: false,
    keyCode: 77,
    defaultPrevented: false,
    target: null,
    composedPath: () => [],
    preventDefault,
    ...overrides
  } as unknown as KeyboardEvent
}

describe('speech.toggle binding (Ctrl/Cmd+Shift+M)', () => {
  it('defaults speech.toggle to Mod+Shift+M', () => {
    expect(DEFAULT_SHORTCUT_BINDINGS['speech.toggle']).toEqual([
      { key: 'm', modifiers: ['Mod', 'Shift'] }
    ])
  })

  it('maps Mod to Control on non-mac platforms and Meta on macOS', () => {
    const binding = DEFAULT_SHORTCUT_BINDINGS['speech.toggle'][0]
    expect(normalizeBinding(binding, 'other')).toBe('Control+Shift+m')
    expect(normalizeBinding(binding, 'mac')).toBe('Meta+Shift+m')
  })
})

describe('dispatcher event gate', () => {
  it.each([
    ['input', { tagName: 'INPUT' }],
    ['textarea', { tagName: 'TEXTAREA' }],
    ['select', { tagName: 'SELECT' }],
    ['contenteditable', { isContentEditable: true }],
    [
      'nested contenteditable via closest',
      {
        closest: (selector: string) =>
          selector.includes('contenteditable') ? { isContentEditable: true } : null
      }
    ]
  ])('ignores editable target: %s', (_label, target) => {
    expect(
      shouldIgnoreShortcutEvent(
        keyboardEvent({ composedPath: () => [target as unknown as EventTarget] })
      )
    ).toBe(true)
  })

  it.each([
    ['key repeat', { repeat: true }],
    ['IME composition', { isComposing: true }],
    ['legacy IME keyCode 229', { keyCode: 229 }],
    ['already defaultPrevented', { defaultPrevented: true }]
  ])('ignores %s', (_label, overrides) => {
    expect(shouldIgnoreShortcutEvent(keyboardEvent(overrides))).toBe(true)
  })
})

describe('ShortcutRegistry dispatcher', () => {
  it('dispatches speech.toggle for Ctrl+Shift+M on non-mac and calls preventDefault', () => {
    const handler = vi.fn()
    const registry = new ShortcutRegistry({ platform: 'other' })
    registry.register({ actionId: 'speech.toggle', handler })
    const event = keyboardEvent()

    expect(registry.handleKeydown(event)).toBe(true)
    expect(handler).toHaveBeenCalledWith({ actionId: 'speech.toggle', event })
    expect(event.preventDefault).toHaveBeenCalledOnce()
  })

  it('dispatches speech.toggle for Cmd+Shift+M on macOS and rejects Control+Shift+M', () => {
    const handler = vi.fn()
    const registry = new ShortcutRegistry({ platform: 'mac' })
    registry.register({ actionId: 'speech.toggle', handler })

    const controlEvent = keyboardEvent()
    expect(registry.handleKeydown(controlEvent)).toBe(false)
    expect(controlEvent.preventDefault).not.toHaveBeenCalled()

    const metaEvent = keyboardEvent({ ctrlKey: false, metaKey: true })
    expect(registry.handleKeydown(metaEvent)).toBe(true)
    expect(handler).toHaveBeenCalledOnce()
    expect(metaEvent.preventDefault).toHaveBeenCalledOnce()
  })

  it('does not preventDefault when the matched handler declines', () => {
    const registry = new ShortcutRegistry({ platform: 'other' })
    registry.register({ actionId: 'speech.toggle', handler: () => false })
    const event = keyboardEvent()

    expect(registry.handleKeydown(event)).toBe(false)
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('does not preventDefault for an unbound / unregistered action chord', () => {
    const handler = vi.fn()
    const registry = new ShortcutRegistry({
      platform: 'other',
      bindings: { 'speech.toggle': [{ key: 'm', modifiers: ['Mod', 'Shift'] }] }
    })
    registry.register({ actionId: 'speech.toggle', handler })
    const event = keyboardEvent({ key: 'k', shiftKey: false })

    expect(registry.handleKeydown(event)).toBe(false)
    expect(handler).not.toHaveBeenCalled()
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('returns false when the chord matches but no handler is registered', () => {
    const registry = new ShortcutRegistry({ platform: 'other' })
    const event = keyboardEvent()

    expect(registry.handleKeydown(event)).toBe(false)
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('prefers the highest-priority active context over a global handler', () => {
    const globalHandler = vi.fn()
    const contextualHandler = vi.fn()
    const registry = new ShortcutRegistry({ platform: 'other' })
    registry.register({ actionId: 'speech.toggle', handler: globalHandler })
    registry.register({
      actionId: 'speech.toggle',
      handler: contextualHandler,
      context: 'voice-bar',
      priority: 10
    })

    expect(registry.handleKeydown(keyboardEvent())).toBe(true)
    expect(globalHandler).toHaveBeenCalledOnce()
    expect(contextualHandler).not.toHaveBeenCalled()

    registry.setContextActive('voice-bar', true)
    expect(registry.handleKeydown(keyboardEvent())).toBe(true)
    expect(contextualHandler).toHaveBeenCalledOnce()
    expect(globalHandler).toHaveBeenCalledOnce()
  })

  it('never dispatches when repeat, IME, or editable targets block the event', () => {
    const handler = vi.fn()
    const registry = new ShortcutRegistry({ platform: 'other' })
    registry.register({ actionId: 'speech.toggle', handler })

    expect(registry.handleKeydown(keyboardEvent({ repeat: true }))).toBe(false)
    expect(registry.handleKeydown(keyboardEvent({ isComposing: true }))).toBe(false)
    expect(registry.handleKeydown(keyboardEvent({ keyCode: 229 }))).toBe(false)
    expect(
      registry.handleKeydown(
        keyboardEvent({
          composedPath: () => [{ tagName: 'TEXTAREA' } as unknown as EventTarget]
        })
      )
    ).toBe(false)
    expect(handler).not.toHaveBeenCalled()
  })

  it('detaches the window listener on unmount (attach cleanup)', () => {
    const handler = vi.fn()
    const registry = new ShortcutRegistry({ platform: 'other' })
    registry.register({ actionId: 'speech.toggle', handler })

    const listeners = new Map<string, EventListener>()
    const target = {
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        listeners.set(type, listener)
      }),
      removeEventListener: vi.fn((type: string, listener: EventListener) => {
        if (listeners.get(type) === listener) listeners.delete(type)
      })
    }

    const detach = registry.attach(target)
    expect(listeners.has('keydown')).toBe(true)

    const listener = listeners.get('keydown')!
    listener(keyboardEvent() as unknown as Event)
    expect(handler).toHaveBeenCalledOnce()

    detach()
    expect(listeners.has('keydown')).toBe(false)
    expect(target.removeEventListener).toHaveBeenCalledOnce()
  })

  it('stops dispatching after a registration is unmounted', () => {
    const handler = vi.fn()
    const registry = new ShortcutRegistry({ platform: 'other' })
    const unregister = registry.register({ actionId: 'speech.toggle', handler })

    expect(registry.handleKeydown(keyboardEvent())).toBe(true)
    unregister()
    expect(registry.handleKeydown(keyboardEvent())).toBe(false)
    expect(handler).toHaveBeenCalledOnce()
  })
})
