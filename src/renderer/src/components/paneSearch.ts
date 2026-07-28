/**
 * Pure Tastatur-Logik für die Scrollback-Suche im AgentPane:
 * Enter = weiter, Shift+Enter = zurück, Escape = schließen.
 * Extrahiert, damit sie ohne xterm/DOM unit-testbar ist.
 */
export type PaneSearchKeyAction = 'next' | 'previous' | 'close' | null

export function paneSearchKeyAction(event: { key: string; shiftKey: boolean }): PaneSearchKeyAction {
  if (event.key === 'Escape') return 'close'
  if (event.key !== 'Enter') return null
  return event.shiftKey ? 'previous' : 'next'
}

/** Imperative Suche, die der Terminal-Hook dem Pane-Header bereitstellt. */
export interface PaneSearchApi {
  findNext: (query: string, incremental?: boolean) => void
  findPrevious: (query: string) => void
  clear: () => void
}
