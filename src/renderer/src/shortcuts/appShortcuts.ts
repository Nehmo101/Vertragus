import type { ShortcutRegistry } from './registry'

/** Ziel-Routen der Navigations-Shortcuts (Hash-Routing; '' = Workspace). */
export type AppShortcutRoute = '' | '#/inbox' | '#/approvals' | '#/changes'

/** Layout-Modi des Workspace — deckungsgleich mit `WorkspaceLayout` im uiSlice. */
export type AppShortcutLayout = 'canvas' | 'tiles' | 'focus'

/**
 * Seiteneffekte, die die App-Shortcuts auslösen. Bewusst als schmales Interface,
 * damit die Verdrahtung ohne Store/window testbar bleibt. Der Provider füllt es
 * mit exakt denselben Store-Aktionen, die auch die TitleBar/Sidebar-Buttons nutzen.
 *
 * Kein `stopAllAgents`: Der Stop-Confirm-Flow lebt als lokaler State in
 * TitleBar.tsx (`confirmKill`) und wäre per Shortcut nur unter Umgehung des
 * Dialogs erreichbar — siehe Kommentar in bindings.ts.
 */
export interface AppShortcutActions {
  navigate(route: AppShortcutRoute): void
  setWorkspaceLayout(layout: AppShortcutLayout): void
  startAllAgents(): void
  toggleSidebar(): void
  toggleOrchestrator(): void
}

/**
 * App-Shortcuts gelten nur im Hauptfenster: Voice-Overlay (#/voice) und
 * ausgedockte Panes (#/pane/*) haben eigene Fenster mit eigener Bedienung.
 */
export function isMainWindowRoute(hash: string = globalThis.location?.hash ?? ''): boolean {
  return !hash.startsWith('#/voice') && !hash.startsWith('#/pane')
}

/**
 * Registriert alle globalen App-Shortcuts in der übergebenen Registry.
 * Rückgabe: eine Funktion, die sämtliche Registrierungen wieder entfernt.
 */
export function registerAppShortcuts(
  registry: ShortcutRegistry,
  actions: AppShortcutActions,
  isActive: () => boolean = () => isMainWindowRoute()
): () => void {
  const unregisters = [
    registry.register({
      actionId: 'nav.workspace',
      handler: () => actions.navigate(''),
      isActive
    }),
    registry.register({
      actionId: 'nav.inbox',
      handler: () => actions.navigate('#/inbox'),
      isActive
    }),
    registry.register({
      actionId: 'nav.approvals',
      handler: () => actions.navigate('#/approvals'),
      isActive
    }),
    registry.register({
      actionId: 'nav.changes',
      handler: () => actions.navigate('#/changes'),
      isActive
    }),
    registry.register({
      actionId: 'layout.canvas',
      handler: () => actions.setWorkspaceLayout('canvas'),
      isActive
    }),
    registry.register({
      actionId: 'layout.tiles',
      handler: () => actions.setWorkspaceLayout('tiles'),
      isActive
    }),
    registry.register({
      actionId: 'layout.focus',
      handler: () => actions.setWorkspaceLayout('focus'),
      isActive
    }),
    registry.register({
      actionId: 'agents.startAll',
      handler: () => actions.startAllAgents(),
      isActive
    }),
    registry.register({
      actionId: 'panel.sidebarLeft',
      handler: () => actions.toggleSidebar(),
      isActive
    }),
    registry.register({
      actionId: 'panel.orchestratorRight',
      handler: () => actions.toggleOrchestrator(),
      isActive
    })
  ]
  return () => {
    for (const unregister of unregisters) unregister()
  }
}
