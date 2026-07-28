/**
 * Befehlsliste der Kommandopalette (Mod+K) — bewusst als pure Funktionen ohne
 * Store-Importe, damit alles ohne DOM/Store im node-Testlauf prüfbar bleibt.
 * Die Verdrahtung mit useAppStore/useLayoutStore lebt in CommandPalette.tsx
 * (collectPaletteContext) und ruft ausschließlich bestehende Store-Aktionen auf.
 *
 * Bewusst KEINE destruktiven Befehle (kein stopAll, kein Löschen): der
 * Stop-Confirm-Flow lebt als lokaler State in TitleBar.tsx — siehe den
 * gleichlautenden Kommentar in shortcuts/bindings.ts.
 */

export interface PaletteCommand {
  id: string
  title: string
  /** Zusätzliche Suchbegriffe neben dem Titel (case-insensitive Substring). */
  keywords: readonly string[]
  run(): void
}

export interface PaletteProfileRef {
  id: string
  name: string
}

export interface PaletteAgentRef {
  id: string
  /** Mittelerde-Lore-Name des Agents, z. B. "Boromir". */
  name: string
  /** Anzeige-Rolle, wandert mit in die Suchbegriffe. */
  role?: string
}

/** Ziel-Routen der Navigations-Befehle ('' = Workspace, wie in appShortcuts). */
export type PaletteRoute = '' | '#/inbox' | '#/approvals' | '#/changes' | '#/remote'

export type PaletteLayout = 'canvas' | 'tiles' | 'focus'

export type PalettePanelId = 'sidebar-left' | 'orchestrator-right'

/**
 * Schmale Aktions-Schnittstelle — der Provider füllt sie mit exakt denselben
 * Store-Aktionen, die auch Sidebar/TitleBar nutzen (siehe CommandPalette.tsx).
 */
export interface PaletteActions {
  navigate(route: PaletteRoute): void
  setWorkspaceLayout(layout: PaletteLayout): void
  togglePanel(id: PalettePanelId): void
  startAll(): void
  startProfile(profileId: string): void
  focusAgent(agentId: string): void
  toggleTheme(): void
  toggleReadable(): void
  toggleDensity(): void
  editProfile(profileId: string): void
}

export interface PaletteContext {
  profiles: readonly PaletteProfileRef[]
  runningAgents: readonly PaletteAgentRef[]
  actions: PaletteActions
}

/** Minimale Übersetzer-Signatur, damit i18next-`t` direkt durchgereicht werden kann. */
export type PaletteTranslate = (key: string, options?: { name?: string }) => string

/** Baut die vollständige Befehlsliste für den aktuellen Store-Zustand. */
export function buildCommands(ctx: PaletteContext, t: PaletteTranslate): PaletteCommand[] {
  const { actions } = ctx
  const commands: PaletteCommand[] = [
    {
      id: 'nav.workspace',
      title: t('palette.cmd.navWorkspace'),
      keywords: ['navigation', 'agents', 'panes', 'home'],
      run: () => actions.navigate('')
    },
    {
      id: 'nav.inbox',
      title: t('palette.cmd.navInbox'),
      keywords: ['navigation', 'inbox', 'ideen', 'notizen'],
      run: () => actions.navigate('#/inbox')
    },
    {
      id: 'nav.approvals',
      title: t('palette.cmd.navApprovals'),
      keywords: ['navigation', 'freigaben', 'missionen'],
      run: () => actions.navigate('#/approvals')
    },
    {
      id: 'nav.changes',
      title: t('palette.cmd.navChanges'),
      keywords: ['navigation', 'diff', 'merge', 'review'],
      run: () => actions.navigate('#/changes')
    },
    {
      id: 'nav.remote',
      title: t('palette.cmd.navRemote'),
      keywords: ['navigation', 'remote', 'mobil'],
      run: () => actions.navigate('#/remote')
    },
    {
      id: 'layout.canvas',
      title: t('palette.cmd.layoutCanvas'),
      keywords: ['ansicht', 'canvas', 'board'],
      run: () => actions.setWorkspaceLayout('canvas')
    },
    {
      id: 'layout.tiles',
      title: t('palette.cmd.layoutTiles'),
      keywords: ['ansicht', 'kacheln', 'tiles'],
      run: () => actions.setWorkspaceLayout('tiles')
    },
    {
      id: 'layout.focus',
      title: t('palette.cmd.layoutFocus'),
      keywords: ['ansicht', 'focus', 'einzeln'],
      run: () => actions.setWorkspaceLayout('focus')
    },
    {
      id: 'panel.sidebar',
      title: t('palette.cmd.toggleSidebar'),
      keywords: ['panel', 'seitenleiste', 'links'],
      run: () => actions.togglePanel('sidebar-left')
    },
    {
      id: 'panel.orchestrator',
      title: t('palette.cmd.toggleOrchestrator'),
      keywords: ['panel', 'rechts', 'thread'],
      run: () => actions.togglePanel('orchestrator-right')
    },
    {
      id: 'agents.startAll',
      title: t('palette.cmd.startAll'),
      keywords: ['workspace', 'start', 'session'],
      run: () => actions.startAll()
    },
    {
      id: 'view.theme',
      title: t('palette.cmd.toggleTheme'),
      keywords: ['ansicht', 'dunkel', 'hell', 'dark', 'light'],
      run: () => actions.toggleTheme()
    },
    {
      id: 'view.readable',
      title: t('palette.cmd.toggleReadable'),
      keywords: ['ansicht', 'cli', 'zusammenfassung', 'readable'],
      run: () => actions.toggleReadable()
    },
    {
      id: 'view.density',
      title: t('palette.cmd.toggleDensity'),
      keywords: ['ansicht', 'dichte', 'density', 'compact'],
      run: () => actions.toggleDensity()
    }
  ]
  for (const profile of ctx.profiles) {
    commands.push({
      id: `profile.start.${profile.id}`,
      title: t('palette.cmd.startProfile', { name: profile.name }),
      keywords: ['workspace', 'agents', profile.name],
      run: () => actions.startProfile(profile.id)
    })
  }
  for (const agent of ctx.runningAgents) {
    commands.push({
      id: `agent.focus.${agent.id}`,
      title: t('palette.cmd.focusAgent', { name: agent.name }),
      keywords: agent.role ? ['pane', 'terminal', agent.role] : ['pane', 'terminal'],
      run: () => actions.focusAgent(agent.id)
    })
  }
  for (const profile of ctx.profiles) {
    commands.push({
      id: `profile.edit.${profile.id}`,
      title: t('palette.cmd.editProfile', { name: profile.name }),
      keywords: ['editor', 'einstellungen', profile.name],
      run: () => actions.editProfile(profile.id)
    })
  }
  return commands
}

/**
 * Fuzzy-arme Suche: jedes Whitespace-Token der Eingabe muss als
 * case-insensitiver Substring in Titel oder Schlagworten vorkommen.
 * Leere Eingabe liefert die volle Liste.
 */
export function filterCommands(
  commands: readonly PaletteCommand[],
  query: string
): PaletteCommand[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return [...commands]
  return commands.filter((command) => {
    const haystack = [command.title, ...command.keywords].join(' ').toLowerCase()
    return tokens.every((token) => haystack.includes(token))
  })
}

/**
 * Pfeiltasten-Navigation als pure Funktion: bewegt den aktiven Index um
 * `delta` und wickelt an den Listenenden um. Leere Liste ergibt -1.
 */
export function stepActiveIndex(index: number, delta: number, count: number): number {
  if (count <= 0) return -1
  const start = index < 0 || index >= count ? (delta > 0 ? -1 : count) : index
  return (((start + delta) % count) + count) % count
}

/**
 * Mod+K (Strg+K bzw. Cmd+K) — bewusst ohne Import aus shortcuts/bindings.ts,
 * damit die parallel laufende Bindings-Arbeit die Palette nicht beeinflusst.
 * Beide Mod-Varianten gelten auf beiden Plattformen; Alt/Shift disqualifizieren.
 */
export function isPaletteHotkey(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>
): boolean {
  return (
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === 'k'
  )
}
