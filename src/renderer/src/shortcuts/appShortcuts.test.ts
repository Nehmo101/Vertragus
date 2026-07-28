/**
 * Verdrahtungs-Matrix für die globalen App-Shortcuts:
 * Navigation (Mod+1..4), Layout (Mod+Alt+1..3), Agents (Mod+Shift+Enter),
 * Panels (Mod+B / Mod+Alt+B) — plus Hauptfenster- und Fokus-Guards.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isMainWindowRoute,
  registerAppShortcuts,
  ShortcutRegistry,
  type AppShortcutActions
} from './index'

function keyboardEvent(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  const preventDefault = vi.fn()
  return {
    key: '1',
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    keyCode: 49,
    defaultPrevented: false,
    target: null,
    composedPath: () => [],
    preventDefault,
    ...overrides
  } as unknown as KeyboardEvent
}

function createActions(): AppShortcutActions & {
  navigate: ReturnType<typeof vi.fn>
  setWorkspaceLayout: ReturnType<typeof vi.fn>
  startAllAgents: ReturnType<typeof vi.fn>
  toggleSidebar: ReturnType<typeof vi.fn>
  toggleOrchestrator: ReturnType<typeof vi.fn>
} {
  return {
    navigate: vi.fn(),
    setWorkspaceLayout: vi.fn(),
    startAllAgents: vi.fn(),
    toggleSidebar: vi.fn(),
    toggleOrchestrator: vi.fn()
  }
}

describe('isMainWindowRoute', () => {
  it.each([
    ['', true],
    ['#/inbox', true],
    ['#/approvals', true],
    ['#/changes', true],
    ['#/remote', true],
    ['#/voice', false],
    ['#/pane/agent-1', false]
  ])('hash %j → %s', (hash, expected) => {
    expect(isMainWindowRoute(hash)).toBe(expected)
  })
})

describe('registerAppShortcuts wiring (platform other)', () => {
  let registry: ShortcutRegistry
  let actions: ReturnType<typeof createActions>

  beforeEach(() => {
    registry = new ShortcutRegistry({ platform: 'other' })
    actions = createActions()
    registerAppShortcuts(registry, actions, () => true)
  })

  it.each([
    ['Mod+1 → Workspace', { key: '1' }, ''],
    ['Mod+2 → Inbox', { key: '2' }, '#/inbox'],
    ['Mod+3 → Approvals', { key: '3' }, '#/approvals'],
    ['Mod+4 → Changes', { key: '4' }, '#/changes']
  ] as const)('%s', (_label, overrides, route) => {
    const event = keyboardEvent(overrides)
    expect(registry.handleKeydown(event)).toBe(true)
    expect(actions.navigate).toHaveBeenCalledExactlyOnceWith(route)
    expect(event.preventDefault).toHaveBeenCalledOnce()
  })

  it.each([
    ['Mod+Alt+1 → canvas', { key: '1', altKey: true }, 'canvas'],
    ['Mod+Alt+2 → tiles', { key: '2', altKey: true }, 'tiles'],
    ['Mod+Alt+3 → focus', { key: '3', altKey: true }, 'focus']
  ] as const)('%s', (_label, overrides, layout) => {
    expect(registry.handleKeydown(keyboardEvent(overrides))).toBe(true)
    expect(actions.setWorkspaceLayout).toHaveBeenCalledExactlyOnceWith(layout)
    expect(actions.navigate).not.toHaveBeenCalled()
  })

  it('Mod+Shift+Enter startet alle Agents', () => {
    expect(registry.handleKeydown(keyboardEvent({ key: 'Enter', shiftKey: true }))).toBe(true)
    expect(actions.startAllAgents).toHaveBeenCalledOnce()
  })

  it('Mod+B toggelt die linke Sidebar, Mod+Alt+B das Orchestrator-Panel', () => {
    expect(registry.handleKeydown(keyboardEvent({ key: 'b' }))).toBe(true)
    expect(actions.toggleSidebar).toHaveBeenCalledOnce()
    expect(actions.toggleOrchestrator).not.toHaveBeenCalled()

    expect(registry.handleKeydown(keyboardEvent({ key: 'b', altKey: true }))).toBe(true)
    expect(actions.toggleOrchestrator).toHaveBeenCalledOnce()
    expect(actions.toggleSidebar).toHaveBeenCalledOnce()
  })

  it('registriert keinen Stopp-Shortcut (Confirm-Flow lebt in der TitleBar)', () => {
    // Mod+Shift+. bleibt bewusst unbelegt — siehe bindings.ts.
    expect(registry.handleKeydown(keyboardEvent({ key: '.', shiftKey: true }))).toBe(false)
  })

  it('unregister entfernt alle Registrierungen', () => {
    const freshRegistry = new ShortcutRegistry({ platform: 'other' })
    const freshActions = createActions()
    const unregister = registerAppShortcuts(freshRegistry, freshActions, () => true)
    unregister()
    expect(freshRegistry.handleKeydown(keyboardEvent())).toBe(false)
    expect(freshActions.navigate).not.toHaveBeenCalled()
  })
})

describe('guards', () => {
  it('feuert nicht in Nebenfenstern (#/voice, #/pane/*)', () => {
    const registry = new ShortcutRegistry({ platform: 'other' })
    const actions = createActions()
    let hash = '#/voice'
    registerAppShortcuts(registry, actions, () => isMainWindowRoute(hash))

    expect(registry.handleKeydown(keyboardEvent())).toBe(false)
    hash = '#/pane/agent-1'
    expect(registry.handleKeydown(keyboardEvent())).toBe(false)
    expect(actions.navigate).not.toHaveBeenCalled()

    hash = '#/inbox'
    expect(registry.handleKeydown(keyboardEvent())).toBe(true)
    expect(actions.navigate).toHaveBeenCalledExactlyOnceWith('')
  })

  it('feuert nicht, während der Fokus in einem Input/Textarea/xterm-Textarea liegt', () => {
    const registry = new ShortcutRegistry({ platform: 'other' })
    const actions = createActions()
    registerAppShortcuts(registry, actions, () => true)

    const focusedInput = keyboardEvent({
      composedPath: () => [{ tagName: 'INPUT' } as unknown as EventTarget]
    })
    expect(registry.handleKeydown(focusedInput)).toBe(false)
    expect(focusedInput.preventDefault).not.toHaveBeenCalled()

    // xterm fokussiert eine versteckte Helper-Textarea — gleiche Sperre.
    const xtermTextarea = keyboardEvent({
      key: 'b',
      composedPath: () => [
        { tagName: 'TEXTAREA', isContentEditable: false } as unknown as EventTarget
      ]
    })
    expect(registry.handleKeydown(xtermTextarea)).toBe(false)

    expect(actions.navigate).not.toHaveBeenCalled()
    expect(actions.toggleSidebar).not.toHaveBeenCalled()
  })
})
