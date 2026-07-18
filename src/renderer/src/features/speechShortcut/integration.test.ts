/**
 * Integration seam wired by the renderer app lifecycle: one shared ShortcutRegistry + one
 * SpeechShortcutController linked by `registerSpeechShortcut`, with VoiceBar/Inbox speech
 * contexts registered on the controller. Asserts Ctrl/Cmd+Shift+M fires start/stop exactly
 * once in the active context, and that the security-relevant gates (editable target, IME,
 * repeat, unmount/stale) refuse to dispatch.
 */
import { describe, expect, it, vi } from 'vitest'
import { ShortcutRegistry } from '../../shortcuts'
import { SpeechShortcutController, registerSpeechShortcut } from './index'

function chord(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
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
    preventDefault: vi.fn(),
    ...overrides
  } as unknown as KeyboardEvent
}

function wire() {
  const registry = new ShortcutRegistry({ platform: 'other' })
  const controller = new SpeechShortcutController()
  const unregister = registerSpeechShortcut(registry, controller)
  return { registry, controller, unregister }
}

describe('speech shortcut app wiring', () => {
  it('routes Ctrl+Shift+M to the last activated context exactly once', async () => {
    const { registry, controller } = wire()
    const voiceToggle = vi.fn(async () => undefined)
    const inboxToggle = vi.fn(async () => undefined)
    controller.register('voice-bar', { configured: true, state: 'idle', toggleRecording: voiceToggle }).activate()
    controller.register('inbox', { configured: true, state: 'idle', toggleRecording: inboxToggle }).activate()

    const event = chord()
    expect(registry.handleKeydown(event)).toBe(true)
    expect(event.preventDefault).toHaveBeenCalledOnce()

    // dispatch is async; let the controller settle.
    await Promise.resolve()
    await Promise.resolve()
    expect(inboxToggle).toHaveBeenCalledOnce()
    expect(voiceToggle).not.toHaveBeenCalled()
  })

  it.each([
    ['key repeat', { repeat: true }],
    ['IME composition', { isComposing: true }],
    ['legacy IME keyCode 229', { keyCode: 229 }],
    ['already handled elsewhere', { defaultPrevented: true }],
    ['focus inside a textarea', { composedPath: () => [{ tagName: 'TEXTAREA' } as unknown as EventTarget] }]
  ])('refuses to dispatch when %s (validation negative)', async (_label, overrides) => {
    const { registry, controller } = wire()
    const toggle = vi.fn(async () => undefined)
    controller.register('voice-bar', { configured: true, state: 'idle', toggleRecording: toggle }).activate()

    expect(registry.handleKeydown(chord(overrides))).toBe(false)
    await Promise.resolve()
    expect(toggle).not.toHaveBeenCalled()
  })

  it('stops dispatching after the active context unmounts (dispose)', async () => {
    const { registry, controller } = wire()
    const toggle = vi.fn(async () => undefined)
    const registration = controller.register('voice-bar', {
      configured: true,
      state: 'idle',
      toggleRecording: toggle
    })
    registration.activate()
    registration.dispose()

    expect(registry.handleKeydown(chord())).toBe(true) // registry handler exists…
    await Promise.resolve()
    await Promise.resolve()
    expect(toggle).not.toHaveBeenCalled() // …but the controller has no active context.
  })

  it('detaches the window listener when the provider unmounts', () => {
    const { registry, unregister } = wire()
    const listeners = new Map<string, EventListener>()
    const target = {
      addEventListener: vi.fn((type: string, listener: EventListener) => listeners.set(type, listener)),
      removeEventListener: vi.fn((type: string, listener: EventListener) => {
        if (listeners.get(type) === listener) listeners.delete(type)
      })
    }
    const detach = registry.attach(target)
    expect(listeners.has('keydown')).toBe(true)
    detach()
    unregister()
    expect(listeners.has('keydown')).toBe(false)
  })
})
