import { useEffect, useMemo, type ReactNode } from 'react'
import { useAppStore } from '../store/useAppStore'
import { useLayoutStore } from '../store/layoutStore'
import { ShortcutRegistry } from './registry'
import { detectShortcutPlatform } from './bindings'
import { registerAppShortcuts, type AppShortcutActions } from './appShortcuts'

/**
 * App-weite Shortcuts (Navigation, Layout, Panels, Agents) — Aufbau analog zum
 * SpeechShortcutProvider: eine eigene ShortcutRegistry lauscht auf `keydown` des
 * Renderer-Fensters; das Event-Gate der Registry (shouldIgnoreShortcutEvent)
 * blockt Eingaben in input/textarea/select/contenteditable — inklusive der
 * versteckten xterm-Helper-Textarea des Terminals — sowie IME/Repeat.
 *
 * Der Provider wird in App.tsx nur im Hauptfenster gemountet (die #/voice- und
 * #/pane-Zweige returnen vorher); der isMainWindowRoute-Guard in
 * registerAppShortcuts sichert das zusätzlich zur Laufzeit ab.
 */
export function AppShortcutProvider({
  children,
  target
}: {
  children: ReactNode
  /** Injizierbares Listener-Target für Tests; Standard ist das Renderer-`window`. */
  target?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>
}): JSX.Element {
  const registry = useMemo(() => new ShortcutRegistry({ platform: detectShortcutPlatform() }), [])

  useEffect(() => {
    // Exakt dieselben Aktionen wie die sichtbaren Bedienelemente:
    // Sidebar-Navigation setzt window.location.hash, die TitleBar startet über
    // startAll(), Panel-Toggles laufen über layoutStore.toggleCollapsed.
    const actions: AppShortcutActions = {
      navigate: (route) => {
        window.location.hash = route
      },
      setWorkspaceLayout: (layout) => useAppStore.getState().setWorkspaceLayout(layout),
      startAllAgents: () => {
        void useAppStore.getState().startAll()
      },
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
