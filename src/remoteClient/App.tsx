/**
 * The remote client's three screens: pair, workspace list, terminal.
 *
 * Deliberately small — it mirrors the panel's model (workspace cards with
 * agent chips and question badges) over the remote protocol, and hands a
 * full-screen terminal to whichever agent the user taps. No settings, no
 * editing: the command surface is the same four verbs the server allows.
 */
import { useEffect, useState } from 'react'
import type { RemoteAgentSummary, RemoteWorkspaceSummary } from '@shared/remote/protocol'
import { RemoteTerminal } from './RemoteTerminal'
import { useRemote } from './useRemote'
import './styles.css'

export function App(): React.JSX.Element {
  const api = useRemote()
  const [openAgent, setOpenAgent] = useState<string | null>(null)

  useEffect(() => {
    document.documentElement.dataset.theme = api.theme
  }, [api.theme])

  if (openAgent) {
    return <RemoteTerminal agentId={openAgent} api={api} onBack={() => setOpenAgent(null)} />
  }

  if (api.phase === 'pairing' || api.phase === 'revoked') {
    return (
      <Centered>
        <h1>Vertragus Remote</h1>
        <p>
          {api.phase === 'revoked'
            ? 'Die Sitzung wurde beendet. Öffne den Kopplungs-Link (QR-Code) aus den Vertragus-Einstellungen erneut.'
            : 'Öffne den Kopplungs-Link (QR-Code) aus den Vertragus-Einstellungen, um dieses Gerät zu verbinden.'}
        </p>
      </Centered>
    )
  }

  if (api.phase === 'error') {
    return (
      <Centered>
        <h1>Verbindung fehlgeschlagen</h1>
        <p>{api.error ?? 'Unbekannter Fehler.'}</p>
        <button className="primary" onClick={api.reset}>
          Erneut koppeln
        </button>
      </Centered>
    )
  }

  return (
    <div className="app">
      <header className="app-header">
        <span className="brand">Vertragus</span>
        <span className={`conn ${api.phase === 'ready' ? 'ok' : 'pending'}`}>
          {api.phase === 'ready' ? 'verbunden' : 'verbinde …'}
        </span>
        <button className="ghost" onClick={api.refresh} aria-label="Aktualisieren">
          ⟳
        </button>
      </header>
      <main className="workspace-list">
        {api.workspaces.length === 0 ? (
          <p className="empty">Keine laufenden Workspaces.</p>
        ) : (
          api.workspaces.map((workspace) => (
            <WorkspaceCard
              key={workspace.workspaceId}
              workspace={workspace}
              onOpenAgent={setOpenAgent}
              onStop={() => api.runCommand('workspaces:stop', workspace.workspaceId)}
            />
          ))
        )}
      </main>
    </div>
  )
}

function WorkspaceCard({
  workspace,
  onOpenAgent,
  onStop
}: {
  workspace: RemoteWorkspaceSummary
  onOpenAgent: (agentId: string) => void
  onStop: () => void
}): React.JSX.Element {
  return (
    <section className={`card ${workspace.active ? 'active' : 'inactive'}`}>
      <div className="card-head">
        <span className="card-name">{workspace.name}</span>
        {workspace.profileName ? <span className="card-profile">{workspace.profileName}</span> : null}
        {workspace.active ? (
          <button className="stop" onClick={onStop}>
            Stop
          </button>
        ) : (
          <span className="inactive-tag">beendet</span>
        )}
      </div>
      {workspace.taskText ? <p className="card-task">{workspace.taskText}</p> : null}
      <div className="agents">
        {workspace.agents.map((agent) => (
          <AgentChip key={agent.agentId} agent={agent} onOpen={() => onOpenAgent(agent.agentId)} />
        ))}
      </div>
    </section>
  )
}

function AgentChip({
  agent,
  onOpen
}: {
  agent: RemoteAgentSummary
  onOpen: () => void
}): React.JSX.Element {
  return (
    <button
      className={`chip state-${agent.state}`}
      style={{ '--role': agent.roleColor } as React.CSSProperties}
      onClick={onOpen}
      title={agent.pendingQuestion ?? agent.roleLabel ?? agent.roleId}
    >
      <span className="chip-name">{agent.name}</span>
      {agent.pendingQuestion ? <span className="badge">?</span> : null}
    </button>
  )
}

function Centered({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="centered">
      <div className="centered-inner">{children}</div>
    </div>
  )
}
