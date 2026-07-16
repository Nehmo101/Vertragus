export type WorkspaceRunState =
  | 'running'
  | 'success'
  | 'incomplete'
  | 'failed'
  | 'stopped'
  | 'not-started'
  | 'unknown'

export interface WorkspaceRunPresentation {
  state: WorkspaceRunState
  tone: 'success' | 'failure' | 'neutral'
  symbol: string
  label: string
  accessibleLabel: string
}

export interface WorkspaceRunStatusInput {
  activeAgents: number
  terminalStatus?: unknown
  orchestratorAgentStatus?: unknown
  gitPostProcessingStatus?: unknown
}

/**
 * Keep untrusted/future status values neutral. The explicit terminal run result
 * wins over the pane process status; the latter is only a fallback when no run
 * result has reached the renderer yet.
 */
export function workspaceRunPresentation({
  activeAgents,
  terminalStatus,
  orchestratorAgentStatus,
  gitPostProcessingStatus
}: WorkspaceRunStatusInput): WorkspaceRunPresentation {
  if (activeAgents > 0 || gitPostProcessingStatus === 'running') {
    const label = activeAgents > 0 ? `${activeAgents} aktiv` : 'Git wird verarbeitet'
    return {
      state: 'running',
      tone: 'neutral',
      symbol: '●',
      label,
      accessibleLabel: `Orchestrator-Lauf aktiv, ${label}`
    }
  }

  if (gitPostProcessingStatus === 'failed') {
    return {
      state: 'failed',
      tone: 'failure',
      symbol: '×',
      label: 'Git fehlgeschlagen',
      accessibleLabel: 'Orchestrator-Lauf wegen Git-Post-Processing fehlgeschlagen'
    }
  }
  if (gitPostProcessingStatus === 'clean' || gitPostProcessingStatus === 'pushed') {
    return {
      state: 'success',
      tone: 'success',
      symbol: '✓',
      label: 'Erfolgreich',
      accessibleLabel: 'Orchestrator-Lauf einschließlich Git-Post-Processing erfolgreich'
    }
  }

  switch (terminalStatus) {
    case 'success':
      return {
        state: 'success',
        tone: 'success',
        symbol: '✓',
        label: 'Erfolgreich',
        accessibleLabel: 'Orchestrator-Lauf erfolgreich'
      }
    case 'needs-work':
      return {
        state: 'incomplete',
        tone: 'failure',
        symbol: '!',
        label: 'Unvollständig',
        accessibleLabel: 'Orchestrator-Lauf unvollständig'
      }
    case 'error':
      return {
        state: 'failed',
        tone: 'failure',
        symbol: '×',
        label: 'Fehlgeschlagen',
        accessibleLabel: 'Orchestrator-Lauf fehlgeschlagen'
      }
    case 'stopped':
      return {
        state: 'stopped',
        tone: 'neutral',
        symbol: '■',
        label: 'Abgebrochen',
        accessibleLabel: 'Orchestrator-Lauf abgebrochen'
      }
    case undefined:
      if (orchestratorAgentStatus === 'error') {
        return {
          state: 'failed',
          tone: 'failure',
          symbol: '×',
          label: 'Fehlgeschlagen',
          accessibleLabel: 'Orchestrator-Prozess fehlgeschlagen'
        }
      }
      if (orchestratorAgentStatus === 'stopped') {
        return {
          state: 'stopped',
          tone: 'neutral',
          symbol: '■',
          label: 'Abgebrochen',
          accessibleLabel: 'Orchestrator-Prozess abgebrochen'
        }
      }
      return {
        state: 'not-started',
        tone: 'neutral',
        symbol: '○',
        label: 'Nicht gestartet',
        accessibleLabel: 'Orchestrator-Lauf nicht gestartet'
      }
    default:
      return {
        state: 'unknown',
        tone: 'neutral',
        symbol: '?',
        label: 'Status unbekannt',
        accessibleLabel: 'Orchestrator-Lauf mit unbekanntem Status'
      }
  }
}
