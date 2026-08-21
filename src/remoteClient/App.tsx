/**
 * The remote client's three screens: pair, overview, terminal.
 *
 * It mirrors the panel's model (workspace cards with agent rows, questions and
 * the task board) over the remote protocol, and hands a full-screen terminal to
 * whichever agent the user taps. No settings, no editing: the command surface
 * is the same few verbs the server allows. Since Track 0 the phone can also do
 * the two things that used to require the desktop TUI: start a workspace WITH a
 * goal (H2) and answer an agent's open MCP question (H1).
 *
 * The overview NEVER unmounts while a terminal is open. That is the fix for
 * "coming back from a terminal always lands at the top": the old code
 * early-returned `<RemoteTerminal/>`, which tore the whole list down and took
 * the document scroll offset, every card's open state and every half-typed
 * answer with it. The terminal is `position: fixed; inset: 0` (terminal.css),
 * so it can simply cover a list that is still there.
 *
 * The alternative — unmount, and restore the offset with `scrollTo` on the way
 * back — loses on three counts. It restores one of the three things that were
 * lost, so the card state and the drafts would each need a store of their own
 * anyway. It cannot restore *before* the restored list has laid out, so on iOS
 * Safari the offset is clamped against a document that is briefly shorter and
 * the user lands somewhere near, but not at, their place. And it fights the
 * browser: `history.scrollRestoration` defaults to 'auto', so a back gesture
 * already restores the offset, and a second programmatic scroll on top of that
 * is the visible jump the user complained about. Keeping the tree mounted has
 * nothing to restore, and the browser's own restoration agrees with it.
 *
 * State that individual cards used to own (expansion, drafts, the shown-ended
 * flag) is held here for the same reason one level down: collapsing a card
 * unmounts its composer, and the same question is answerable from the inbox at
 * the top and from the card it belongs to.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import HoundLogo from '@renderer/panel/HoundLogo'
import type {
  RemoteAgentSummary,
  RemoteProfileSummary,
  RemoteWorkspaceSummary
} from '@shared/remote/protocol'
import { haptic } from './haptics'
import { remoteCopy, remoteLanguage, type RemoteCopy } from './i18n'
import {
  inboxEntriesFor,
  inboxPrompt,
  inboxSource,
  questionInbox,
  type InboxEntry
} from './inbox'
import {
  answerDraftKey,
  composerDraftKey,
  connectionClass,
  connectionLabel,
  connectionState,
  GOAL_DRAFT_KEY,
  historyAction,
  readExpansionState,
  scrollRestoreTarget,
  shouldShowBackToTop,
  writeExpansionState
} from './navState'
import { RemoteTerminal } from './RemoteTerminal'
import { taskBoardSize, taskRows } from './taskBoard'
import {
  nextThemePreference,
  readThemePreference,
  resolveTheme,
  themeColorFrom,
  themeGlyph,
  themePreferenceLabel,
  writeThemePreference,
  type ThemePreference
} from './themePreference'
import { useRemote, type RemoteApi } from './useRemote'
import { pullIndicatorHeight, pullLabel, usePullToRefresh } from './usePullToRefresh'
import { useVisualViewport } from './useVisualViewport'
import {
  agentDotKind,
  agentStatusLine,
  endedWorkspaces,
  everyCardExpanded,
  hasActiveWorkspace,
  isWorkspaceExpanded,
  liveWorkspaces,
  orderWorkspaces,
  setAllExpanded,
  workspaceCardClass,
  workspaceGoalLine
} from './viewModel'
import './styles.css'
import './overview.css'

const INBOX_DOM_ID = 'question-inbox'

/** How long the composer says "sent" before the note fades out again. */
const SENT_NOTICE_MS = 2200

function cardDomId(workspaceId: string): string {
  return `workspace-${workspaceId}`
}

type Drafts = Readonly<Record<string, string>>
type SetDraft = (key: string, value: string) => void

export function App(): React.JSX.Element {
  const api = useRemote()
  const copy = remoteCopy(api.locale)
  const [openAgent, setOpenAgent] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => readExpansionState())
  const [showEnded, setShowEnded] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [everConnected, setEverConnected] = useState(false)
  const [themePreference, setThemePreference] = useState<ThemePreference>(() =>
    readThemePreference()
  )
  useVisualViewport()
  useTerminalHistory(openAgent, setOpenAgent)
  useDocumentScrollLock(openAgent !== null)

  const setDraft = useCallback<SetDraft>((key, value) => {
    setDrafts((current) => ({ ...current, [key]: value }))
  }, [])

  const theme = resolveTheme(themePreference, api.theme)
  useLayoutEffect(() => {
    const root = document.documentElement
    root.dataset.theme = theme
    // Read the token back rather than restating it: the browser paints its own
    // chrome with this value, and a status bar that disagrees with the page
    // under it is the seam that makes a web app look like a web page.
    const background = getComputedStyle(root).getPropertyValue('--bg')
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', themeColorFrom(background, theme))
  }, [theme])

  // The document language follows the host, exactly like the copy does: the
  // page is served as one static bundle for both languages, so index.html can
  // only carry a placeholder until `hello.locale` arrives. A wrong `lang` is
  // not cosmetic on a phone — it is what a screen reader picks its voice from
  // and what the on-screen keyboard uses for autocorrect.
  useEffect(() => {
    document.documentElement.lang = remoteLanguage(api.locale)
  }, [api.locale])

  useEffect(() => {
    if (api.phase === 'ready') setEverConnected(true)
  }, [api.phase])

  // A screen the user cannot act on must not keep a terminal open behind it:
  // the socket that fed it is gone, and its history entry has to be popped
  // while `openAgent` is still the thing that owns it.
  useEffect(() => {
    if (api.phase === 'pairing' || api.phase === 'revoked' || api.phase === 'error') {
      setOpenAgent(null)
    }
  }, [api.phase])

  // A push arrives every few seconds and hands back a new array each time, but
  // only the set of ids matters for the prune — so the effect depends on a
  // value a push that changed nothing else leaves untouched, and no storage
  // write happens. Serialized rather than joined on a separator, so nothing is
  // assumed about what a workspace id may contain.
  const workspaceKey = JSON.stringify(api.workspaces.map((workspace) => workspace.workspaceId))
  useEffect(() => {
    writeExpansionState(expanded, JSON.parse(workspaceKey) as string[])
  }, [expanded, workspaceKey])

  const inbox = useMemo(() => questionInbox(orderWorkspaces(api.workspaces)), [api.workspaces])

  const cycleTheme = (): void => {
    const next = nextThemePreference(themePreference)
    setThemePreference(next)
    writeThemePreference(next)
    haptic('tap')
  }

  const jumpToWorkspace = (workspaceId: string): void => {
    const workspace = api.workspaces.find((entry) => entry.workspaceId === workspaceId)
    if (workspace && !workspace.active) setShowEnded(true)
    setExpanded((current) => ({ ...current, [workspaceId]: true }))
    // The card has to be open and laid out before it has a position to scroll
    // to; the state above only reaches the DOM on the next frame.
    requestAnimationFrame(() => {
      document.getElementById(cardDomId(workspaceId))?.scrollIntoView({ block: 'start' })
    })
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

  const connection = connectionState(api.phase, api.online, everConnected)

  return (
    <>
      {/*
       * `visibility: hidden` rather than an unmount or `display: none`: it
       * keeps the list's layout — and therefore the document height the scroll
       * offset is measured against — while taking the tree out of the paint,
       * the hit-test and the accessibility tree, so nothing behind the
       * terminal can be reached or read out.
       */}
      <div className={openAgent ? 'app is-under-terminal' : 'app'}>
        <Header
          api={api}
          copy={copy}
          connection={connection}
          openQuestions={inbox.length}
          themePreference={themePreference}
          onCycleTheme={cycleTheme}
        />
        <Overview
          api={api}
          copy={copy}
          inbox={inbox}
          drafts={drafts}
          setDraft={setDraft}
          expanded={expanded}
          setExpanded={setExpanded}
          showEnded={showEnded}
          setShowEnded={setShowEnded}
          onOpenAgent={setOpenAgent}
          onJumpToWorkspace={jumpToWorkspace}
          paused={openAgent !== null}
        />
      </div>
      {openAgent ? (
        <RemoteTerminal
          agentId={openAgent}
          api={api}
          copy={copy}
          onBack={() => setOpenAgent(null)}
        />
      ) : null}
    </>
  )
}

/**
 * One history entry per open terminal, so Android's back button and Safari's
 * edge swipe close it instead of leaving the app — on a phone those are the
 * "back" a user reaches for before the one on the screen.
 *
 * The push carries no URL. `useRemote` already replaced the current entry once
 * to strip the pairing token out of the address bar; passing a URL here would
 * push a second entry wearing that same address, which is both a duplicate and
 * a second chance to leak it into a screenshot. Same URL, one extra entry.
 *
 * `pushed` is the whole state machine: after a hardware back the entry is
 * already gone, so closing must not call `back()` again and walk the user out
 * of the app; after the in-app button it is still there, so closing must.
 */
function useTerminalHistory(
  openAgent: string | null,
  setOpenAgent: (agentId: string | null) => void
): void {
  const previous = useRef<string | null>(null)
  const pushed = useRef(false)

  useEffect(() => {
    const action = historyAction(previous.current, openAgent, pushed.current)
    previous.current = openAgent
    if (action === 'push') {
      pushed.current = true
      window.history.pushState(null, '')
    } else if (action === 'back') {
      pushed.current = false
      window.history.back()
    }
  }, [openAgent])

  useEffect(() => {
    const onPop = (): void => {
      if (!pushed.current) return
      pushed.current = false
      setOpenAgent(null)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [setOpenAgent])
}

/**
 * Freeze the document while the terminal covers it. The overlay is fixed, so
 * a drag that lands on one of its non-scrolling parts would otherwise pan the
 * list behind it and the user would come back to an offset they never chose.
 *
 * `overflow: hidden` on the root element keeps the offset (unlike the
 * `position: fixed` body trick, which zeroes it and then has to put it back).
 * The recorded offset is the belt to that braces: a browser that lets the
 * document move anyway is corrected on the way out, and one that does not gets
 * no `scrollTo` at all — see `scrollRestoreTarget`. A layout effect, so the
 * correction lands before the restored list is painted.
 */
function useDocumentScrollLock(locked: boolean): void {
  useLayoutEffect(() => {
    if (!locked) return
    const root = document.documentElement
    const recorded = window.scrollY
    const previousOverflow = root.style.overflow
    root.style.overflow = 'hidden'
    return () => {
      root.style.overflow = previousOverflow
      const target = scrollRestoreTarget(recorded, window.scrollY)
      if (target !== undefined) window.scrollTo(0, target)
    }
  }, [locked])
}

/** Whether the list has been scrolled far enough for a way back to the top. */
function useScrolledDown(active: boolean): boolean {
  const [down, setDown] = useState(false)
  useEffect(() => {
    if (!active) {
      setDown(false)
      return
    }
    const update = (): void => setDown(shouldShowBackToTop(window.scrollY))
    update()
    window.addEventListener('scroll', update, { passive: true })
    return () => window.removeEventListener('scroll', update)
  }, [active])
  return down
}

function Header({
  api,
  copy,
  connection,
  openQuestions,
  themePreference,
  onCycleTheme
}: {
  api: RemoteApi
  copy: RemoteCopy
  connection: ReturnType<typeof connectionState>
  openQuestions: number
  themePreference: ThemePreference
  onCycleTheme: () => void
}): React.JSX.Element {
  return (
    <header className="app-header">
      <HoundLogo size={28} badge={false} />
      <div className="brand-block">
        <span className="brand">{copy.wordmark}</span>
        <span className={connectionClass(connection)} role="status">
          {connectionLabel(connection, copy)}
        </span>
      </div>
      <div className="header-actions">
        {openQuestions > 0 ? (
          <button
            type="button"
            className="inbox-pill"
            aria-label={copy.inboxPillLabel(openQuestions)}
            onClick={() =>
              document.getElementById(INBOX_DOM_ID)?.scrollIntoView({ block: 'start' })
            }
          >
            <span aria-hidden="true">?</span>
            <span aria-hidden="true">{openQuestions}</span>
          </button>
        ) : null}
        <button
          type="button"
          className="ghost"
          onClick={onCycleTheme}
          aria-label={copy.themeToggle(
            themePreferenceLabel(nextThemePreference(themePreference), copy)
          )}
        >
          {themeGlyph(themePreference)}
        </button>
        <button className="ghost" type="button" onClick={api.refresh} aria-label={copy.refresh}>
          ⟳
        </button>
      </div>
    </header>
  )
}

function Overview({
  api,
  copy,
  inbox,
  drafts,
  setDraft,
  expanded,
  setExpanded,
  showEnded,
  setShowEnded,
  onOpenAgent,
  onJumpToWorkspace,
  paused
}: {
  api: RemoteApi
  copy: RemoteCopy
  inbox: readonly InboxEntry[]
  drafts: Drafts
  setDraft: SetDraft
  expanded: Readonly<Record<string, boolean>>
  setExpanded: React.Dispatch<React.SetStateAction<Record<string, boolean>>>
  showEnded: boolean
  setShowEnded: React.Dispatch<React.SetStateAction<boolean>>
  onOpenAgent: (agentId: string) => void
  onJumpToWorkspace: (workspaceId: string) => void
  /** The terminal covers the list: no gestures, no floating controls. */
  paused: boolean
}): React.JSX.Element {
  const pull = usePullToRefresh(api.refresh, !paused)
  const scrolledDown = useScrolledDown(!paused)
  const ordered = orderWorkspaces(api.workspaces)
  const live = liveWorkspaces(ordered)
  const ended = endedWorkspaces(ordered)
  const visible = showEnded ? ordered : live
  const allExpanded = everyCardExpanded(visible, expanded)

  const renderCard = (workspace: RemoteWorkspaceSummary): React.JSX.Element => (
    <WorkspaceCard
      key={workspace.workspaceId}
      workspace={workspace}
      questions={inboxEntriesFor(inbox, workspace.workspaceId)}
      expanded={isWorkspaceExpanded(workspace, expanded)}
      onToggle={() =>
        setExpanded((current) => ({
          ...current,
          [workspace.workspaceId]: !isWorkspaceExpanded(workspace, current)
        }))
      }
      api={api}
      copy={copy}
      drafts={drafts}
      setDraft={setDraft}
      onOpenAgent={onOpenAgent}
    />
  )

  return (
    <>
      {/*
       * Silent to assistive technology: this labels a touch gesture, and a
       * live region would narrate three state changes per pull. The `⟳` in
       * the header is the same refresh, reachable without one.
       */}
      <div
        className={`pull-indicator is-${pull.phase}`}
        style={{ height: pullIndicatorHeight(pull.phase, pull.distance) }}
        aria-hidden="true"
      >
        <span>{pullLabel(pull.phase, copy)}</span>
      </div>
      <main className="workspace-list">
        <QuestionInbox
          api={api}
          copy={copy}
          entries={inbox}
          drafts={drafts}
          setDraft={setDraft}
          onJump={onJumpToWorkspace}
        />
        <StartForm
          api={api}
          copy={copy}
          drafts={drafts}
          setDraft={setDraft}
          hasLiveRun={hasActiveWorkspace(api.workspaces)}
        />
        {ordered.length === 0 ? (
          <div className="empty">
            <p>{copy.empty}</p>
            <p className="empty-hint">{copy.emptyHint}</p>
          </div>
        ) : null}
        {visible.length > 1 ? (
          <div className="list-controls">
            <button
              type="button"
              className="ghost-inline"
              // Only the cards on screen: a decision about a hidden ended card
              // is the user's too, and this control never saw it.
              onClick={() =>
                setExpanded((current) => ({
                  ...current,
                  ...setAllExpanded(visible, !allExpanded)
                }))
              }
            >
              {allExpanded ? copy.collapseAll : copy.expandAll}
            </button>
          </div>
        ) : null}
        {live.map(renderCard)}
        {ended.length > 0 ? (
          <button
            type="button"
            className="ended-toggle"
            aria-expanded={showEnded}
            onClick={() => setShowEnded((current) => !current)}
          >
            {showEnded ? copy.hideEnded : copy.showEnded(ended.length)}
          </button>
        ) : null}
        {showEnded ? ended.map(renderCard) : null}
      </main>
      {scrolledDown ? (
        <button
          type="button"
          className="to-top"
          aria-label={copy.backToTop}
          onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
        >
          <span aria-hidden="true">↑</span>
        </button>
      ) : null}
    </>
  )
}

/**
 * Every open question in the run, above everything else.
 *
 * A question is the only thing on this screen that blocks a run, and the old
 * client buried each one inside whichever card owned it — three workspaces
 * down, behind a collapsed head. The same entries are still drawn on their
 * cards; they share this component and, through `drafts`, the same half-typed
 * answer.
 */
function QuestionInbox({
  api,
  copy,
  entries,
  drafts,
  setDraft,
  onJump
}: {
  api: RemoteApi
  copy: RemoteCopy
  entries: readonly InboxEntry[]
  drafts: Drafts
  setDraft: SetDraft
  onJump: (workspaceId: string) => void
}): React.JSX.Element | null {
  if (entries.length === 0) return null
  return (
    <section className="inbox" id={INBOX_DOM_ID} aria-labelledby="inbox-title">
      <h2 className="inbox-title" id="inbox-title">
        <span>{copy.inboxTitle}</span>
        <span className="inbox-count">{copy.inboxCount(entries.length)}</span>
      </h2>
      {entries.map((entry) => (
        <article className={`inbox-entry is-${entry.kind}`} key={entry.key}>
          <p className="inbox-source">{inboxSource(entry)}</p>
          <AnswerForm
            api={api}
            copy={copy}
            entry={entry}
            drafts={drafts}
            setDraft={setDraft}
            idPrefix="inbox"
          />
          <button type="button" className="ghost-inline" onClick={() => onJump(entry.workspaceId)}>
            {copy.inboxJump(entry.workspaceName)}
          </button>
        </article>
      ))}
    </section>
  )
}

/**
 * Start a workspace from the phone — profile picker plus the goal field (H2).
 * Without a goal the start stays allowed (back-compat); the card below then
 * says so. Closed by default while a run is already live so the list can
 * scroll to the work — but once the user has opened or closed it themselves,
 * that decision outranks the default, which is why `open` is tri-state.
 */
function StartForm({
  api,
  copy,
  drafts,
  setDraft,
  hasLiveRun
}: {
  api: RemoteApi
  copy: RemoteCopy
  drafts: Drafts
  setDraft: SetDraft
  hasLiveRun: boolean
}): React.JSX.Element | null {
  const [profiles, setProfiles] = useState<RemoteProfileSummary[]>([])
  const [profileId, setProfileId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [openedByUser, setOpenedByUser] = useState<boolean | null>(null)
  const ready = api.phase === 'ready'
  const goal = drafts[GOAL_DRAFT_KEY] ?? ''

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
        setDraft(GOAL_DRAFT_KEY, '')
        setBusy(false)
      },
      (cause: Error) => {
        setError(cause.message)
        setBusy(false)
      }
    )
  }

  return (
    <details
      className="card start-card"
      open={openedByUser ?? !hasLiveRun}
      onToggle={(event) => setOpenedByUser(event.currentTarget.open)}
    >
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
        aria-label={copy.goalPlaceholder}
        value={goal}
        enterKeyHint="enter"
        onChange={(event) => setDraft(GOAL_DRAFT_KEY, event.target.value)}
      />
      {error ? <p className="form-error">{error}</p> : null}
      <button className="primary" type="button" disabled={busy} onClick={start}>
        {busy ? copy.starting : goal.trim() ? copy.startWithGoal : copy.startWithoutGoal}
      </button>
    </details>
  )
}

function WorkspaceCard({
  workspace,
  questions,
  expanded,
  onToggle,
  api,
  copy,
  drafts,
  setDraft,
  onOpenAgent
}: {
  workspace: RemoteWorkspaceSummary
  questions: readonly InboxEntry[]
  expanded: boolean
  onToggle: () => void
  api: RemoteApi
  copy: RemoteCopy
  drafts: Drafts
  setDraft: SetDraft
  onOpenAgent: (agentId: string) => void
}): React.JSX.Element {
  const [openAnswers, setOpenAnswers] = useState<Record<string, boolean>>({})
  const [confirmStop, setConfirmStop] = useState(false)
  // Held here, not in `TaskBoard`: the card body is only built while the card
  // is open, so a flag living down there would be forgotten by the collapse.
  const [tasksOpen, setTasksOpen] = useState(false)
  const goalLine = workspaceGoalLine(workspace, copy)
  const bodyId = `${cardDomId(workspace.workspaceId)}-body`

  const stop = (): void => {
    haptic('warn')
    api.runCommand('workspaces:stop', workspace.workspaceId)
    setConfirmStop(false)
  }

  return (
    <section
      className={workspaceCardClass(workspace, expanded)}
      id={cardDomId(workspace.workspaceId)}
    >
      <div className="card-head">
        <button
          type="button"
          className="card-toggle"
          aria-expanded={expanded}
          aria-controls={bodyId}
          aria-label={expanded ? copy.collapseCard(workspace.name) : copy.expandCard(workspace.name)}
          onClick={onToggle}
        >
          <span className="card-name">{workspace.name}</span>
          {workspace.profileName ? (
            <span className="card-profile">{workspace.profileName}</span>
          ) : null}
          <span className="card-count">{copy.agents(workspace.agents.length)}</span>
          {!expanded && questions.length > 0 ? <span className="card-attention" /> : null}
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
            <button
              type="button"
              className="stop"
              onClick={() => {
                haptic('tap')
                setConfirmStop(true)
              }}
            >
              {copy.stop}
            </button>
          )
        ) : (
          <span className="inactive-tag">{copy.inactive}</span>
        )}
      </div>
      {/* The wrapper stays in the DOM so `aria-controls` always resolves; the
          body itself is only built when it is on screen. */}
      <div id={bodyId} hidden={!expanded}>
        {expanded ? (
          <>
            {workspace.orchestratorIdle ? (
              <p className="card-task idle-hint">{copy.idleHint}</p>
            ) : null}
            {goalLine ? (
              <p className={workspace.goalText ? 'card-task' : 'card-task no-goal'}>{goalLine}</p>
            ) : null}
            {workspace.taskText ? <p className="card-task">{workspace.taskText}</p> : null}
            {questions
              .filter((entry) => entry.kind === 'user')
              .map((entry) => (
                <div className="answer-form is-user" key={entry.key}>
                  <AnswerForm
                    api={api}
                    copy={copy}
                    entry={entry}
                    drafts={drafts}
                    setDraft={setDraft}
                    idPrefix="card"
                  />
                </div>
              ))}
            <ul className="agents">
              {workspace.agents.map((agent) => {
                const question = questions.find((entry) => entry.agentId === agent.agentId)
                const answerOpen = question ? openAnswers[question.key] === true : false
                return (
                  <li
                    key={agent.agentId}
                    className={agent.parentId ? 'agent-line is-child' : 'agent-line'}
                  >
                    <AgentRow
                      agent={agent}
                      copy={copy}
                      hasQuestion={question !== undefined}
                      answerOpen={answerOpen}
                      onOpen={() => onOpenAgent(agent.agentId)}
                      onToggleAnswer={() =>
                        question &&
                        setOpenAnswers((current) => ({
                          ...current,
                          [question.key]: !current[question.key]
                        }))
                      }
                    />
                    {question && answerOpen ? (
                      <div className="answer-form">
                        <AnswerForm
                          api={api}
                          copy={copy}
                          entry={question}
                          drafts={drafts}
                          setDraft={setDraft}
                          idPrefix="card"
                          onDismiss={() =>
                            setOpenAnswers((current) => ({ ...current, [question.key]: false }))
                          }
                        />
                      </div>
                    ) : null}
                  </li>
                )
              })}
            </ul>
            <TaskBoard
              workspace={workspace}
              copy={copy}
              open={tasksOpen}
              onToggle={() => setTasksOpen((current) => !current)}
            />
            {workspace.active ? (
              <Composer
                api={api}
                workspaceId={workspace.workspaceId}
                copy={copy}
                drafts={drafts}
                setDraft={setDraft}
              />
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  )
}

/**
 * The run's plan, which has travelled on `RemoteWorkspaceSummary.tasks` since
 * S4 and which this client used to drop on the floor. Collapsed by default:
 * on a phone the agent rows are what the user came for, and a ten-task board
 * above the composer would push it off the screen.
 */
function TaskBoard({
  workspace,
  copy,
  open,
  onToggle
}: {
  workspace: RemoteWorkspaceSummary
  copy: RemoteCopy
  open: boolean
  onToggle: () => void
}): React.JSX.Element | null {
  const rows = taskRows(workspace.tasks, workspace.agents, copy)
  const listId = `${cardDomId(workspace.workspaceId)}-tasks`
  if (rows.length === 0) return null
  return (
    <div className="task-board">
      <button
        type="button"
        className="ended-toggle task-toggle"
        aria-expanded={open}
        aria-controls={listId}
        onClick={onToggle}
      >
        {open ? copy.hideTasks : copy.showTasks(taskBoardSize(workspace.tasks))}
      </button>
      <div id={listId} hidden={!open}>
        {open ? (
          <>
            <h3 className="task-title">{copy.tasksTitle}</h3>
            <ul className="task-list">
              {rows.map((row) => (
                <li key={row.taskId} className={`task-row is-${row.tone}`}>
                  <span className="task-subject">{row.subject}</span>
                  <span className="task-meta">
                    <span className="task-status">{row.statusLabel}</span>
                    {row.readinessLabel ? <span>{row.readinessLabel}</span> : null}
                    {row.ownerLabel ? <span>{row.ownerLabel}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
    </div>
  )
}

/**
 * One open question and the field that answers it — an agent's MCP question
 * (H1) and the orchestrator's `ask_user` (D3) take the same `answer_question`
 * verb, differing only in the addressee, so they take the same form. The draft
 * lives in the shared map above, which is what lets the inbox copy and the
 * card copy of one question be the same half-typed sentence.
 */
function AnswerForm({
  api,
  copy,
  entry,
  drafts,
  setDraft,
  idPrefix,
  onDismiss
}: {
  api: RemoteApi
  copy: RemoteCopy
  entry: InboxEntry
  drafts: Drafts
  setDraft: SetDraft
  /** Two mounted copies of one question must not share a DOM id. */
  idPrefix: string
  onDismiss?: () => void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const draftKey = answerDraftKey(entry.key)
  const text = drafts[draftKey] ?? ''
  const promptId = `${idPrefix}-${entry.key}`

  const submit = (): void => {
    const trimmed = text.trim()
    if (!trimmed || busy) return
    setBusy(true)
    setError(null)
    api
      .runCommand('answer_question', undefined, {
        workspaceId: entry.workspaceId,
        agentId: entry.agentId,
        questionId: entry.questionId,
        text: trimmed
      })
      .then(
        () => {
          setBusy(false)
          setDraft(draftKey, '')
          haptic('confirm')
        },
        (cause: Error) => {
          setError(cause.message)
          setBusy(false)
        }
      )
  }

  return (
    <>
      <p className="answer-question" id={promptId}>
        {inboxPrompt(entry, copy)}
      </p>
      <textarea
        className="goal-input"
        rows={3}
        placeholder={copy.answerPlaceholder}
        aria-labelledby={promptId}
        value={text}
        enterKeyHint="send"
        onChange={(event) => setDraft(draftKey, event.target.value)}
      />
      {error ? <p className="form-error">{error}</p> : null}
      <div className="answer-actions">
        <button className="primary" type="button" disabled={busy || !text.trim()} onClick={submit}>
          {busy ? copy.answerSending : copy.answerSend}
        </button>
        {onDismiss ? (
          <button
            type="button"
            className="ghost-inline"
            aria-label={copy.dismissAnswer}
            onClick={onDismiss}
          >
            <span aria-hidden="true">×</span>
          </button>
        ) : null}
      </div>
    </>
  )
}

/** D2: steer the run from the phone — wakes the orchestrator's await_events. */
function Composer({
  api,
  workspaceId,
  copy,
  drafts,
  setDraft
}: {
  api: RemoteApi
  workspaceId: string
  copy: RemoteCopy
  drafts: Drafts
  setDraft: SetDraft
}): React.JSX.Element {
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  const sentTimer = useRef<number | undefined>(undefined)
  const draftKey = composerDraftKey(workspaceId)
  const text = drafts[draftKey] ?? ''

  useEffect(() => () => window.clearTimeout(sentTimer.current), [])

  const submit = (): void => {
    const trimmed = text.trim()
    if (!trimmed) return
    setError(null)
    api.runCommand('user_message', undefined, { workspaceId, text: trimmed }).then(
      () => {
        setDraft(draftKey, '')
        haptic('confirm')
        // The message leaves no trace on this screen — it lands in the
        // orchestrator's terminal — so the confirmation is the only proof the
        // tap did anything.
        setSent(true)
        window.clearTimeout(sentTimer.current)
        sentTimer.current = window.setTimeout(() => setSent(false), SENT_NOTICE_MS)
      },
      (cause: Error) => setError(cause.message)
    )
  }

  return (
    <div className="composer">
      <textarea
        rows={2}
        placeholder={copy.composerPlaceholder}
        aria-label={copy.composerPlaceholder}
        value={text}
        enterKeyHint="send"
        onChange={(event) => setDraft(draftKey, event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            submit()
          }
        }}
      />
      <div className="composer-actions">
        <button className="primary" type="button" disabled={!text.trim()} onClick={submit}>
          {copy.composerSend}
        </button>
        <span className="sent-note" role="status">
          {sent ? copy.composerSent : ''}
        </span>
      </div>
      {error ? <p className="form-error">{error}</p> : null}
    </div>
  )
}

function AgentRow({
  agent,
  copy,
  hasQuestion,
  answerOpen,
  onOpen,
  onToggleAnswer
}: {
  agent: RemoteAgentSummary
  copy: RemoteCopy
  hasQuestion: boolean
  answerOpen: boolean
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
      {hasQuestion ? (
        <button
          type="button"
          className="badge"
          onClick={onToggleAnswer}
          aria-expanded={answerOpen}
          aria-label={
            answerOpen ? copy.dismissAnswer : copy.answerQuestion(agent.name)
          }
          title={agent.pendingQuestion}
        >
          <span aria-hidden="true">?</span>
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
