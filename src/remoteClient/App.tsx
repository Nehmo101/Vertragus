/**
 * The remote client's three screens: pair, workspace list, terminal.
 *
 * Deliberately small — it mirrors the panel's model (workspace cards with
 * agent rows and question banners) over the remote protocol, and hands a
 * full-screen terminal to whichever agent the user taps. No settings, no
 * editing: the command surface is the same few verbs the server allows.
 * Since Track 0 the phone can also do the two things that used to require the
 * desktop TUI: start a workspace WITH a goal (H2) and answer an agent's open
 * MCP question (H1) — both over the gateway, both on the same host paths the
 * panel and the orchestrator tools use.
 */
import { useEffect, useState } from 'react'
import HoundLogo from '@renderer/panel/HoundLogo'
import type {
  RemoteAgentSummary,
  RemoteProfileSummary,
  RemoteWorkspaceSummary
} from '@shared/remote/protocol'
import { remoteCopy, remoteLanguage, type RemoteCopy } from './i18n'
import { RemoteTerminal } from './RemoteTerminal'
import { useRemote, type RemoteApi } from './useRemote'
import { useVisualViewport } from './useVisualViewport'
import {
  agentDotKind,
  agentStatusLine,
  endedWorkspaces,
  hasActiveWorkspace,
  isWorkspaceExpanded,
  liveWorkspaces,
  orderWorkspaces,
  workspaceCardClass,
  workspaceGoalLine
} from './viewModel'
import './styles.css'

export function App(): React.JSX.Element {
  const api = useRemote()
  const copy = remoteCopy(api.locale)
  const [openAgent, setOpenAgent] = useState<string | null>(null)
  useVisualViewport()

  useEffect(() => {
    document.documentElement.dataset.theme = api.theme
    document.querySelector('meta[name="theme-color"]')?.setAttribute(
      'content',
      api.theme === 'light' ? '#f4f1ea' : '#0e1013'
    )
  }, [api.theme])

  // The document language follows the host, exactly like the copy does: the
  // page is served as one static bundle for both languages, so index.html can
  // only carry a placeholder until `hello.locale` arrives. A wrong `lang` is
  // not cosmetic on a phone — it is what a screen reader picks its voice from
  // and what the on-screen keyboard uses for autocorrect.
  useEffect(() => {
    document.documentElement.lang = remoteLanguage(api.locale)
  }, [api.locale])

  if (openAgent) {
    return (
      <RemoteTerminal
        agentId={openAgent}
        api={api}
        copy={copy}
        onBack={() => setOpenAgent(null)}
      />
    )
  }

  if (api.phase === 'pairing' || api.phase === 'revoked') {
    return (
      <Centered>
        <HoundLogo size={36} badge={false} />
        <h1>{api.phase === 'revoked' ? copy.revokedTitle : copy.pairingTitle}</h1>
        <p>{api.phase === 'revoked' ? copy.revokedBody : copy.pairingBody}</p>
      </Centered>
    )
  }

  if (api.phase === 'error') {
    return (
      <Centered>
        <HoundLogo size={36} badge={false} />
        <h1>{copy.errorTitle}</h1>
        <p>{api.error ? copy[api.error] : copy.unknownError}</p>
        <button className="primary" type="button" onClick={api.reset}>
          {copy.pairAgain}
        </button>
      </Centered>
    )
  }

  return (
    <div className="app">
      <header className="app-header">
        <HoundLogo size={28} badge={false} />
        <div className="brand-block">
          <span className="brand">{copy.wordmark}</span>
          <span className={`conn ${api.phase === 'ready' ? 'ok' : 'pending'}`}>
            {api.phase === 'ready' ? copy.connected : copy.connecting}
          </span>
        </div>
        <button className="ghost" type="button" onClick={api.refresh} aria-label={copy.refresh}>
          ⟳
        </button>
      </header>
      <main className="workspace-list">
        <StartForm api={api} copy={copy} collapsed={hasActiveWorkspace(api.workspaces)} />
        <WorkspaceList api={api} copy={copy} onOpenAgent={setOpenAgent} />
      </main>
    </div>
  )
}

function WorkspaceList({
  api,
  copy,
  onOpenAgent
}: {
  api: RemoteApi
  copy: RemoteCopy
  onOpenAgent: (agentId: string) => void
}): React.JSX.Element {
  const ordered = orderWorkspaces(api.workspaces)
  const live = liveWorkspaces(ordered)
  const ended = endedWorkspaces(ordered)
  const [showEnded, setShowEnded] = useState(false)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const toggle = (workspaceId: string, workspace: RemoteWorkspaceSummary): void => {
    setExpanded((current) => ({
      ...current,
      [workspaceId]: !isWorkspaceExpanded(workspace, current)
    }))
  }

  if (ordered.length === 0) {
    return <p className="empty">{copy.empty}</p>
  }

  return (
    <>
      {live.map((workspace) => (
        <WorkspaceCard
          key={workspace.workspaceId}
          workspace={workspace}
          expanded={isWorkspaceExpanded(workspace, expanded)}
          onToggle={() => toggle(workspace.workspaceId, workspace)}
          api={api}
          copy={copy}
          onOpenAgent={onOpenAgent}
        />
      ))}
      {ended.length > 0 ? (
        <button
          type="button"
          className="ended-toggle"
          onClick={() => setShowEnded((current) => !current)}
        >
          {showEnded ? copy.hideEnded : copy.showEnded(ended.length)}
        </button>
      ) : null}
      {showEnded
        ? ended.map((workspace) => (
            <WorkspaceCard
              key={workspace.workspaceId}
              workspace={workspace}
              expanded={isWorkspaceExpanded(workspace, expanded)}
              onToggle={() => toggle(workspace.workspaceId, workspace)}
              api={api}
              copy={copy}
              onOpenAgent={onOpenAgent}
            />
          ))
        : null}
    </>
  )
}

/**
 * Start a workspace from the phone — profile picker plus the goal field (H2).
 * Without a goal the start stays allowed (back-compat); the card below then
 * says so. Collapsed by default while a run is already live so the list can
 * scroll to the work, not the form.
 */
function StartForm({
  api,
  copy,
  collapsed
}: {
  api: RemoteApi
  copy: RemoteCopy
  collapsed: boolean
}): React.JSX.Element | null {
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
    // `api` is a fresh object each render; `ready` is the real trigger.
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
    <details className="card start-card" open={!collapsed}>
      <summary className="card-head start-summary">
        <span className="card-name">{copy.newWorkspace}</span>
      </summary>
      <select
        className="start-profile"
        value={profileId}
        onChange={(event) => setProfileId(event.target.value)}
        aria-label={copy.profile}
      >
        {profiles.map((profile) => (
          <option key={profile.id} value={profile.id}>
            {profile.name}
          </option>
        ))}
      </select>
      <textarea
        className="goal-input"
        rows={3}
        placeholder={copy.goalPlaceholder}
        value={goal}
        enterKeyHint="enter"
        onChange={(event) => setGoal(event.target.value)}
      />
      {error ? <p className="form-error">{error}</p> : null}
      <button className="primary" type="button" disabled={busy} onClick={start}>
        {goal.trim() ? copy.startWithGoal : copy.startWithoutGoal}
      </button>
    </details>
  )
}

function WorkspaceCard({
  workspace,
  expanded,
  onToggle,
  api,
  copy,
  onOpenAgent
}: {
  workspace: RemoteWorkspaceSummary
  expanded: boolean
  onToggle: () => void
  api: RemoteApi
  copy: RemoteCopy
  onOpenAgent: (agentId: string) => void
}): React.JSX.Element {
  const [answering, setAnswering] = useState<string | null>(null)
  const [confirmStop, setConfirmStop] = useState(false)
  const goalLine = workspaceGoalLine(workspace, copy)

  const stop = (): void => {
    api.runCommand('workspaces:stop', workspace.workspaceId)
    setConfirmStop(false)
  }

  return (
    <section className={workspaceCardClass(workspace, expanded)}>
      <div className="card-head">
        <button
          type="button"
          className="card-toggle"
          aria-expanded={expanded}
          onClick={onToggle}
        >
          <span className="card-name">{workspace.name}</span>
          {workspace.profileName ? (
            <span className="card-profile">{workspace.profileName}</span>
          ) : null}
          <span className="card-count">{copy.agents(workspace.agents.length)}</span>
          {!expanded && workspaceNeedsDot(workspace) ? <span className="card-attention" /> : null}
        </button>
        {workspace.active ? (
          confirmStop ? (
            <span className="stop-confirm">
              <button type="button" className="stop is-confirm" onClick={stop}>
                {copy.stopConfirm}
              </button>
              <button type="button" className="ghost-inline" onClick={() => setConfirmStop(false)}>
                {copy.stopCancel}
              </button>
            </span>
          ) : (
            <button type="button" className="stop" onClick={() => setConfirmStop(true)}>
              {copy.stop}
            </button>
          )
        ) : (
          <span className="inactive-tag">{copy.inactive}</span>
        )}
      </div>
      {expanded ? (
        <>
          {workspace.orchestratorIdle ? <p className="card-task idle-hint">{copy.idleHint}</p> : null}
          {goalLine ? (
            <p className={workspace.goalText ? 'card-task' : 'card-task no-goal'}>{goalLine}</p>
          ) : null}
          {workspace.taskText ? <p className="card-task">{workspace.taskText}</p> : null}
          {workspace.userQuestion ? (
            <UserQuestionForm api={api} workspace={workspace} copy={copy} />
          ) : null}
          <ul className="agents">
            {workspace.agents.map((agent) => (
              <li
                key={agent.agentId}
                className={agent.parentId ? 'agent-line is-child' : 'agent-line'}
              >
                <AgentRow
                  agent={agent}
                  copy={copy}
                  onOpen={() => onOpenAgent(agent.agentId)}
                  onToggleAnswer={() =>
                    setAnswering((current) => (current === agent.agentId ? null : agent.agentId))
                  }
                />
              </li>
            ))}
          </ul>
          {answering
            ? (() => {
                const agent = workspace.agents.find((entry) => entry.agentId === answering)
                if (!agent?.pendingQuestion || !agent.pendingQuestionId) return null
                return (
                  <AnswerForm
                    api={api}
                    copy={copy}
                    workspaceId={workspace.workspaceId}
                    agent={agent}
                    questionId={agent.pendingQuestionId}
                    onDone={() => setAnswering(null)}
                  />
                )
              })()
            : null}
          {workspace.active ? (
            <Composer api={api} workspaceId={workspace.workspaceId} copy={copy} />
          ) : null}
        </>
      ) : null}
    </section>
  )
}

function workspaceNeedsDot(workspace: RemoteWorkspaceSummary): boolean {
  return Boolean(workspace.userQuestion) || workspace.agents.some((agent) => agent.pendingQuestion)
}

/**
 * D3: the orchestrator's question to the HUMAN — answered with the reserved
 * agent id "user" over the same answer_question verb as agent questions.
 */
function UserQuestionForm({
  api,
  workspace,
  copy
}: {
  api: RemoteApi
  workspace: RemoteWorkspaceSummary
  copy: RemoteCopy
}): React.JSX.Element {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const question = workspace.userQuestion!

  const submit = (): void => {
    if (!text.trim() || busy) return
    setBusy(true)
    setError(null)
    api
      .runCommand('answer_question', undefined, {
        workspaceId: workspace.workspaceId,
        agentId: 'user',
        questionId: question.questionId,
        text: text.trim()
      })
      .then(
        () => {
          setText('')
          setBusy(false)
        },
        (cause: Error) => {
          setError(cause.message)
          setBusy(false)
        }
      )
  }

  return (
    <div className="answer-form is-user">
      <p className="answer-question">{copy.userQuestion(question.question)}</p>
      <textarea
        className="goal-input"
        rows={4}
        placeholder={copy.answerPlaceholder}
        value={text}
        enterKeyHint="enter"
        onChange={(event) => setText(event.target.value)}
      />
      {error ? <p className="form-error">{error}</p> : null}
      <button className="primary" type="button" disabled={busy || !text.trim()} onClick={submit}>
        {copy.answerSend}
      </button>
    </div>
  )
}

/** D2: steer the run from the phone — wakes the orchestrator's await_events. */
function Composer({
  api,
  workspaceId,
  copy
}: {
  api: RemoteApi
  workspaceId: string
  copy: RemoteCopy
}): React.JSX.Element {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = (): void => {
    const trimmed = text.trim()
    if (!trimmed) return
    setError(null)
    api.runCommand('user_message', undefined, { workspaceId, text: trimmed }).then(
      () => setText(''),
      (cause: Error) => setError(cause.message)
    )
  }

  return (
    <div className="composer">
      <textarea
        rows={2}
        placeholder={copy.composerPlaceholder}
        value={text}
        enterKeyHint="send"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            submit()
          }
        }}
      />
      <button className="primary" type="button" disabled={!text.trim()} onClick={submit}>
        {copy.composerSend}
      </button>
      {error ? <p className="form-error">{error}</p> : null}
    </div>
  )
}

function AnswerForm({
  api,
  copy,
  workspaceId,
  agent,
  questionId,
  onDone
}: {
  api: RemoteApi
  copy: RemoteCopy
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
        rows={4}
        placeholder={copy.answerPlaceholder}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      {error ? <p className="form-error">{error}</p> : null}
      <button className="primary" type="button" disabled={busy || !text.trim()} onClick={submit}>
        {copy.answerSend}
      </button>
    </div>
  )
}

function AgentRow({
  agent,
  copy,
  onOpen,
  onToggleAnswer
}: {
  agent: RemoteAgentSummary
  copy: RemoteCopy
  onOpen: () => void
  onToggleAnswer: () => void
}): React.JSX.Element {
  const kind = agentDotKind(agent)
  return (
    <div className="chip-group">
      <button
        type="button"
        className={`agent-row state-${agent.state}`}
        style={{ '--role': agent.roleColor } as React.CSSProperties}
        onClick={onOpen}
        aria-label={copy.openAgent(agent.name)}
      >
        <span
          className={`dot-live ${kind === 'idle' ? 'is-idle' : 'is-working'} ${kind === 'working-orchestrator' ? 'is-orchestrator' : ''}`}
        />
        <span className="agent-text">
          <span className="chip-name">{agent.name}</span>
          <span className="chip-status">
            {agentStatusLine(agent, {
              working: copy.working,
              waiting: copy.waiting,
              stopped: copy.stopped
            })}
          </span>
        </span>
      </button>
      {agent.pendingQuestion && agent.pendingQuestionId ? (
        <button
          type="button"
          className="badge"
          onClick={onToggleAnswer}
          aria-label={copy.answerQuestion(agent.name)}
          title={agent.pendingQuestion}
        >
          ?
        </button>
      ) : null}
    </div>
  )
}

function Centered({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="centered">
      <div className="centered-inner">{children}</div>
    </div>
  )
}
