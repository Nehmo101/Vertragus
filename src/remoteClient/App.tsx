/**
 * The remote client's three screens: pair, workspace list, terminal.
 *
 * Deliberately small — it mirrors the panel's model (workspace cards with
 * agent chips and question badges) over the remote protocol, and hands a
 * full-screen terminal to whichever agent the user taps. No settings, no
 * editing: the command surface is the same few verbs the server allows.
 * Since Track 0 the phone can also do the two things that used to require the
 * desktop TUI: start a workspace WITH a goal (H2) and answer an agent's open
 * MCP question (H1) — both over the gateway, both on the same host paths the
 * panel and the orchestrator tools use.
 */
import { useEffect, useState } from 'react'
import type {
  RemoteAgentSummary,
  RemoteProfileSummary,
  RemoteWorkspaceSummary
} from '@shared/remote/protocol'
import { RemoteTerminal } from './RemoteTerminal'
import { useRemote, type RemoteApi } from './useRemote'
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
        <StartForm api={api} />
        {api.workspaces.length === 0 ? (
          <p className="empty">Keine laufenden Workspaces.</p>
        ) : (
          api.workspaces.map((workspace) => (
            <WorkspaceCard
              key={workspace.workspaceId}
              workspace={workspace}
              api={api}
              onOpenAgent={setOpenAgent}
            />
          ))
        )}
      </main>
    </div>
  )
}

/**
 * Start a workspace from the phone — profile picker plus the goal field (H2).
 * Without a goal the start stays allowed (back-compat); the card below then
 * says so. The xterm-with-software-keyboard path this replaces was the worst
 * one in the whole remote plan.
 */
function StartForm({ api }: { api: RemoteApi }): React.JSX.Element | null {
  const [profiles, setProfiles] = useState<RemoteProfileSummary[]>([])
  const [profileId, setProfileId] = useState('')
  const [goal, setGoal] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ready = api.phase === 'ready'

  useEffect(() => {
    if (!ready) return
    api.runCommand('profiles:list').then(
      (result) => {
        const list = Array.isArray(result) ? (result as RemoteProfileSummary[]) : []
        setProfiles(list)
        setProfileId((current) => current || (list[0]?.id ?? ''))
      },
      () => setProfiles([])
    )
    // Once per connection: the profile list only changes on the desktop.
    // (`api` is a fresh object each render but its callbacks are stable —
    // `ready` is the real trigger here.)
  }, [ready])

  if (!ready || profiles.length === 0) return null

  const start = (): void => {
    if (!profileId || busy) return
    setBusy(true)
    setError(null)
    const args: Record<string, string> = { profileId }
    if (goal.trim()) args.goal = goal.trim()
    api.runCommand('workspaces:start', undefined, args).then(
      () => {
        setGoal('')
        setBusy(false)
      },
      (cause: Error) => {
        setError(cause.message)
        setBusy(false)
      }
    )
  }

  return (
    <section className="card start-card">
      <div className="card-head">
        <span className="card-name">Neuer Workspace</span>
      </div>
      <select
        className="start-profile"
        value={profileId}
        onChange={(event) => setProfileId(event.target.value)}
        aria-label="Profil"
      >
        {profiles.map((profile) => (
          <option key={profile.id} value={profile.id}>
            {profile.name}
          </option>
        ))}
      </select>
      <textarea
        className="goal-input"
        rows={2}
        placeholder="Ziel für den Orchestrator … (leer = ohne Ziel starten)"
        value={goal}
        onChange={(event) => setGoal(event.target.value)}
      />
      {error ? <p className="form-error">{error}</p> : null}
      <button className="primary" disabled={busy} onClick={start}>
        {goal.trim() ? 'Mit Ziel starten' : 'Ohne Ziel starten'}
      </button>
    </section>
  )
}

function WorkspaceCard({
  workspace,
  api,
  onOpenAgent
}: {
  workspace: RemoteWorkspaceSummary
  api: RemoteApi
  onOpenAgent: (agentId: string) => void
}): React.JSX.Element {
  /** The agent whose question is being answered inline, if any. */
  const [answering, setAnswering] = useState<string | null>(null)
  return (
    <section className={`card ${workspace.active ? 'active' : 'inactive'}`}>
      <div className="card-head">
        <span className="card-name">{workspace.name}</span>
        {workspace.profileName ? <span className="card-profile">{workspace.profileName}</span> : null}
        {workspace.active ? (
          <button className="stop" onClick={() => api.runCommand('workspaces:stop', workspace.workspaceId)}>
            Stop
          </button>
        ) : (
          <span className="inactive-tag">beendet</span>
        )}
      </div>
      {workspace.goalText ? (
        <p className="card-task">Ziel: {workspace.goalText}</p>
      ) : workspace.active ? (
        <p className="card-task no-goal">Kein Ziel — Orchestrator wartet</p>
      ) : null}
      {workspace.taskText ? <p className="card-task">{workspace.taskText}</p> : null}
      <div className="agents">
        {workspace.agents.map((agent) => (
          <AgentChip
            key={agent.agentId}
            agent={agent}
            onOpen={() => onOpenAgent(agent.agentId)}
            onToggleAnswer={() =>
              setAnswering((current) => (current === agent.agentId ? null : agent.agentId))
            }
          />
        ))}
      </div>
      {answering
        ? (() => {
            const agent = workspace.agents.find((entry) => entry.agentId === answering)
            if (!agent?.pendingQuestion || !agent.pendingQuestionId) return null
            return (
              <AnswerForm
                api={api}
                workspaceId={workspace.workspaceId}
                agent={agent}
                questionId={agent.pendingQuestionId}
                onDone={() => setAnswering(null)}
              />
            )
          })()
        : null}
    </section>
  )
}

/**
 * Answer one agent question (H1). Goes over the gateway's `answer_question` —
 * the same host path the orchestrator's send_to_agent{questionId} takes, so
 * the parked ask_orchestrator waiter (or the sentinel PTY delivery) resolves
 * exactly as if the orchestrator had answered.
 */
function AnswerForm({
  api,
  workspaceId,
  agent,
  questionId,
  onDone
}: {
  api: RemoteApi
  workspaceId: string
  agent: RemoteAgentSummary
  questionId: string
  onDone: () => void
}): React.JSX.Element {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = (): void => {
    if (!text.trim() || busy) return
    setBusy(true)
    setError(null)
    api
      .runCommand('answer_question', undefined, {
        workspaceId,
        agentId: agent.agentId,
        questionId,
        text: text.trim()
      })
      .then(
        () => {
          setBusy(false)
          onDone()
        },
        (cause: Error) => {
          setError(cause.message)
          setBusy(false)
        }
      )
  }

  return (
    <div className="answer-form">
      <p className="answer-question">
        {agent.name}: {agent.pendingQuestion}
      </p>
      <textarea
        className="goal-input"
        rows={3}
        placeholder="Antwort …"
        value={text}
        autoFocus
        onChange={(event) => setText(event.target.value)}
      />
      {error ? <p className="form-error">{error}</p> : null}
      <button className="primary" disabled={busy || !text.trim()} onClick={submit}>
        Antworten
      </button>
    </div>
  )
}

function AgentChip({
  agent,
  onOpen,
  onToggleAnswer
}: {
  agent: RemoteAgentSummary
  onOpen: () => void
  onToggleAnswer: () => void
}): React.JSX.Element {
  return (
    <span className="chip-group">
      <button
        className={`chip state-${agent.state}`}
        style={{ '--role': agent.roleColor } as React.CSSProperties}
        onClick={onOpen}
        title={agent.pendingQuestion ?? agent.roleLabel ?? agent.roleId}
      >
        <span className="chip-name">{agent.name}</span>
      </button>
      {agent.pendingQuestion && agent.pendingQuestionId ? (
        <button
          className="badge"
          onClick={onToggleAnswer}
          aria-label={`Frage von ${agent.name} beantworten`}
          title={agent.pendingQuestion}
        >
          ?
        </button>
      ) : null}
    </span>
  )
}

function Centered({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="centered">
      <div className="centered-inner">{children}</div>
    </div>
  )
}
