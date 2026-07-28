import { useEffect, useMemo, type ReactNode } from 'react'
import { useAppStore } from '../store/useAppStore'
import { useLayoutStore } from '../store/layoutStore'
import { ShortcutRegistry } from './registry'
import { detectShortcutPlatform } from './bindings'
import { registerAppShortcuts, type AppShortcutActions } from './appShortcuts'

/**
 * App-wide shortcuts (navigation, layout, panels, agents) — built like the
 * SpeechShortcutProvider: a dedicated ShortcutRegistry listens for `keydown`
 * on the renderer window; the registry's event gate (shouldIgnoreShortcutEvent)
 * blocks input into input/textarea/select/contenteditable — including the
 * hidden xterm helper textarea of the terminal — as well as IME/repeat.
 *
 * App.tsx mounts the provider only in the main window (the #/voice and #/pane
 * branches return earlier); the isMainWindowRoute guard in registerAppShortcuts
 * additionally enforces that at runtime.
 */
export function AppShortcutProvider({
  children,
  target
}: {
  children: ReactNode
  /** Injectable listener target for tests; defaults to the renderer `window`. */
  target?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>
}): JSX.Element {
  const registry = useMemo(() => new ShortcutRegistry({ platform: detectShortcutPlatform() }), [])

  useEffect(() => {
    // Exactly the same actions as the visible controls: sidebar navigation sets
    // window.location.hash, the TitleBar starts via startAll(), panel toggles
    // run through layoutStore.toggleCollapsed.
    const actions: AppShortcutActions = {
      navigate: (route) => {
        window.location.hash = route
      },
      setWorkspaceLayout: (layout) => useAppStore.getState().setWorkspaceLayout(layout),
      startAllAgents: () => {
        void useAppStore.getState().startAll()
      },
      // No direct stopAll(): only bumps the request id; the TitleBar then opens
      // its existing "stop all?" confirm (see bindings.ts).
      requestStopAllAgents: () => useAppStore.getState().requestStopAll(),
      toggleSidebar: () => useLayoutStore.getState().toggleCollapsed('sidebar-left'),
      toggleOrchestrator: () => useLayoutStore.getState().toggleCollapsed('orchestrator-right')
    }
    const unregister = registerAppShortcuts(registry, actions)
    const detach = registry.attach(target ?? window)
    return () => {
      detach()
      unregister()
    }
  }, [registry, target])

  return <>{children}</>
}
