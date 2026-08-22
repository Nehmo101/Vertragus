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
 * flag, an answer in flight) is held here for the same reason one level down:
 * collapsing a card unmounts its composer, and the same question is answerable
 * from the inbox at the top and from the card it belongs to.
 *
 * The list itself is ONE keyed array for a third version of the same rule. A
 * run ending is the normal end of a session — the user taps the orchestrator
 * precisely to watch it finish — and with the cards split across a `live` slot
 * and an `ended` slot, that ending unmounted the card the user was inside:
 * React reconciles each child slot separately, so a key cannot carry a
 * component from one to the other. `overviewRows` (viewModel.ts) emits cards
 * and the ended divider as members of one array, and keeps a run that ended
 * while this client was watching in the place it held while it was live.
 */
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
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
  ARG_MAX_CHARS,
  composerDraftKey,
  connectionClass,
  connectionLabel,
  connectionState,
  GOAL_DRAFT_KEY,
  historyAction,
  liveDraftKeys,
  orphanedDrafts,
  popstateAction,
  prefersReducedMotion,
  pruneDrafts,
  readExpansionState,
  scrollBehavior,
  scrollRestoreTarget,
  shouldShowBackToTop,
  writeExpansionState,
  type OrphanDraft
} from './navState'
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
  advanceSeenLive,
  agentDotKind,
  agentStatusLine,
  everyCardExpanded,
  hasActiveWorkspace,
  isWorkspaceExpanded,
  keepSelectedProfile,
  orderWorkspaces,
  overviewRows,
  rowWorkspaces,
  safeRoleColor,
  setAllExpanded,
  startFormOpen,
  workspaceCardClass,
  workspaceGoalLine
} from './viewModel'
import './styles.css'
import './overview.css'

/**
 * The terminal is half the client's JavaScript (xterm plus its fit and search
 * addons) and none of its landing screen: the app opens on the overview, and
 * a terminal is a deliberate tap that a phone on a tunnel should not have paid
 * for on the way to the first paint.
 *
 * One promise serves both paths. `lazy` calls this on the tap, the prefetch
 * below calls it when the socket goes ready, and whichever comes first is the
 * one request the other awaits — a prefetch that raced the tap would otherwise
 * be a second parse of the same 500 kB while the user is looking at a spinner.
 */
let terminalModule: Promise<typeof import('./RemoteTerminal')> | undefined

function loadTerminal(): Promise<typeof import('./RemoteTerminal')> {
  terminalModule ??= import('./RemoteTerminal')
  return terminalModule
}

const RemoteTerminal = lazy(async () => ({ default: (await loadTerminal()).RemoteTerminal }))

const INBOX_DOM_ID = 'question-inbox'

/** How long the composer says "sent" before the note fades out again. */
const SENT_NOTICE_MS = 2200

function cardDomId(workspaceId: string): string {
  return `workspace-${workspaceId}`
}

/** The `?` badge that opens an answer field, so dismissing can hand focus back. */
function askBadgeDomId(entryKey: string): string {
  return `ask-${entryKey}`
}

function answerPanelDomId(entryKey: string): string {
  return `answer-${entryKey}`
}

/**
 * Move the reader, not just the viewport. A `scrollIntoView` leaves a screen
 * reader's virtual cursor exactly where it was, so "jump to Paradiso" moves
 * the screen for everyone except the user who most needed the jump. The
 * targets carry `tabIndex={-1}` for this; `preventScroll` leaves the scrolling
 * to the call that already did it.
 */
function focusTarget(id: string): void {
  const element = document.getElementById(id)
  if (element instanceof HTMLElement) element.focus({ preventScroll: true })
}

type Copy = RemoteCopy

type Drafts = Readonly<Record<string, string>>
type SetDraft = (key: string, value: string) => void
/** Answer sends in flight, keyed by `InboxEntry.key` — see `AnswerForm`. */
type Sending = Readonly<Record<string, boolean>>

export function App(): React.JSX.Element {
  const api = useRemote()
  const copy = useMemo<Copy>(() => remoteCopy(api.locale), [api.locale])
  const [openAgent, setOpenAgent] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => readExpansionState())
  const [showEnded, setShowEnded] = useState(false)
  const [drafts, setDrafts] = useState<Drafts>({})
  const [sending, setSending] = useState<Sending>({})
  const [everConnected, setEverConnected] = useState(false)
  const [themePreference, setThemePreference] = useState<ThemePreference>(() =>
    readThemePreference()
  )

  /*
   * Two one-way corrections on `phase`, adjusted during render for the same
   * reason `seenLive` below is. An effect whose whole body is a `setState` is
   * a second render either way; taking it here keeps the correction inside the
   * pass that caused it, instead of committing one frame of the wrong thing
   * and fixing it after the paint. Both are guarded, so they settle in one
   * extra pass and cost nothing on a render that changes neither.
   *
   * `everConnected` is what separates "connecting" from "reconnecting" in the
   * header (`connectionState`); it can only ever go true.
   *
   * A screen the user cannot act on must not keep a terminal open behind it:
   * the socket that fed it is gone, and its history entry has to be popped
   * while `openAgent` is still the thing that owns it — which is precisely
   * what clearing it does, because `useTerminalHistory` watches that value and
   * turns the null into the `history.back()` that drops the entry.
   */
  if (api.phase === 'ready' && !everConnected) setEverConnected(true)
  if (
    openAgent !== null &&
    (api.phase === 'pairing' || api.phase === 'revoked' || api.phase === 'error')
  ) {
    setOpenAgent(null)
  }

  useVisualViewport()
  useTerminalHistory(openAgent, setOpenAgent)
  useDocumentScrollLock(openAgent !== null)

  /*
   * Which runs this client has watched. Adjusted during render rather than in
   * an effect on purpose: the push that flips `active` to false is the render
   * that has to already know the card belongs where it is, or the card is
   * moved once — and, with the ended group collapsed, unmounted once — before
   * the effect can say otherwise. `advanceSeenLive` returns the same set when
   * nothing changed, so this settles in one pass and a quiet push costs
   * nothing. (React re-runs the component immediately on a set during render;
   * children never see the stale value.)
   */
  const [seenLive, setSeenLive] = useState<ReadonlySet<string>>(() => new Set())
  const nextSeenLive = advanceSeenLive(seenLive, api.workspaces)
  if (nextSeenLive !== seenLive) setSeenLive(nextSeenLive)

  const setDraft = useCallback<SetDraft>((key, value) => {
    // Clearing DELETES: a sent message leaving an empty string behind is how
    // the map grew a key per workspace and per question and never gave one up.
    setDrafts((current) => {
      if (value === '') {
        if (!(key in current)) return current
        const next = { ...current }
        delete next[key]
        return next
      }
      return { ...current, [key]: value }
    })
  }, [])

  // Only ever holds what is in flight: a finished send gives its key back
  // rather than leaving a `false` behind for every question ever answered.
  const setSendingFor = useCallback((key: string, busy: boolean) => {
    setSending((current) => {
      if (busy) return { ...current, [key]: true }
      if (!(key in current)) return current
      const next = { ...current }
      delete next[key]
      return next
    })
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

  /*
   * Fetch the terminal chunk once the list is up and the socket is quiet, so
   * the tap that opens one finds it already parsed. Idle rather than
   * immediate: `ready` is the same moment the first `workspaces` push and the
   * fonts are landing, and a 500 kB chunk elbowing into that is the one thing
   * the split was meant to stop. It cannot fight the tap either — both go
   * through `loadTerminal`, which hands out one promise.
   */
  useEffect(() => {
    if (api.phase !== 'ready') return
    const idle = window.requestIdleCallback
    if (!idle) {
      const timer = window.setTimeout(() => void loadTerminal(), 1200)
      return () => window.clearTimeout(timer)
    }
    const handle = idle(() => void loadTerminal(), { timeout: 4000 })
    return () => window.cancelIdleCallback?.(handle)
  }, [api.phase])

  // The inbox reads the run live-first; the card list does not (see
  // `overviewRows`), so this order is the inbox's own and is sorted once here.
  const inbox = useMemo(() => questionInbox(orderWorkspaces(api.workspaces)), [api.workspaces])

  /*
   * Two jobs, one dependency: the set of ids and the set of open questions are
   * what decides which drafts are still reachable. Serialized rather than
   * joined on a separator, so nothing is assumed about what an id may contain,
   * and a push that changed neither leaves this effect asleep.
   */
  const workspaceKey = JSON.stringify(api.workspaces.map((workspace) => workspace.workspaceId))
  const inboxKey = JSON.stringify(inbox.map((entry) => entry.key))
  const workspaceIds = useMemo(() => JSON.parse(workspaceKey) as string[], [workspaceKey])
  const inboxKeys = useMemo(() => JSON.parse(inboxKey) as string[], [inboxKey])

  useEffect(() => {
    writeExpansionState(expanded, workspaceIds)
  }, [expanded, workspaceIds])

  // Bounded in the same pass that changes it, like `seenLive` above and for
  // the same reason: an effect would leave one commit in which the map still
  // holds keys the screen has already stopped drawing fields for.
  const prunedDrafts = pruneDrafts(drafts, workspaceIds)
  if (prunedDrafts !== drafts) setDrafts(prunedDrafts)

  const orphans = useMemo(
    () => orphanedDrafts(prunedDrafts, liveDraftKeys(workspaceIds, inboxKeys), workspaceIds),
    [prunedDrafts, workspaceIds, inboxKeys]
  )

  const cycleTheme = (): void => {
    const next = nextThemePreference(themePreference)
    setThemePreference(next)
    writeThemePreference(next)
    haptic('tap')
  }

  const jumpToWorkspace = (workspaceId: string): void => {
    const workspace = api.workspaces.find((entry) => entry.workspaceId === workspaceId)
    // Only a run that folded away needs the group opened; one that ended while
    // the user was here has kept its place in the list all along.
    if (workspace && !workspace.active && !seenLive.has(workspaceId)) setShowEnded(true)
    setExpanded((current) => ({ ...current, [workspaceId]: true }))
    // The card has to be open and laid out before it has a position to scroll
    // to; the state above only reaches the DOM on the next frame.
    requestAnimationFrame(() => {
      const id = cardDomId(workspaceId)
      document.getElementById(id)?.scrollIntoView({ block: 'start' })
      focusTarget(id)
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
    /*
     * Which button is the primary one depends on what is broken. `unreachable`
     * is a route, not a credential: the token is fine, the hook is already
     * retrying behind this screen, and re-pairing would throw a working secret
     * away to solve a problem it is not the cause of — so the retry leads and
     * `pairAgain` stays as the way out for someone who has decided the desktop
     * is not coming back. `pairingFailed` is the opposite (the token IS what is
     * wrong) and keeps `pairAgain` alone.
     *
     * The retry is disabled while an exchange is on the wire, with the label
     * carrying the reason — the same shape the start form and the answer field
     * use for a send in flight, so a tap that lands during the hook's own
     * backoff attempt is not a second attempt.
     */
    const retryable = api.error === 'unreachable'
    return (
      <Centered>
        <HoundLogo size={36} badge={false} />
        <h1>{copy.errorTitle}</h1>
        <p>{api.error ? copy[api.error] : copy.unknownError}</p>
        {retryable ? (
          <button
            className="primary"
            type="button"
            disabled={api.retrying}
            onClick={api.retryPairing}
          >
            {api.retrying ? copy.retrying : copy.retry}
          </button>
        ) : null}
        <button
          className={retryable ? 'ghost-inline' : 'primary'}
          type="button"
          onClick={api.reset}
        >
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
          orphans={orphans}
          drafts={prunedDrafts}
          setDraft={setDraft}
          sending={sending}
          setSending={setSendingFor}
          expanded={expanded}
          setExpanded={setExpanded}
          seenLive={seenLive}
          showEnded={showEnded}
          setShowEnded={setShowEnded}
          onOpenAgent={setOpenAgent}
          onJumpToWorkspace={jumpToWorkspace}
          paused={openAgent !== null}
        />
      </div>
      {openAgent ? (
        <Suspense fallback={<div className="terminal-pending" role="status" aria-live="polite" />}>
          <RemoteTerminal
            agentId={openAgent}
            api={api}
            copy={copy}
            onBack={() => setOpenAgent(null)}
          />
        </Suspense>
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
  /** Traversals we asked for and have not seen land — see `popstateAction`. */
  const pendingBacks = useRef(0)

  useEffect(() => {
    const action = historyAction(previous.current, openAgent, pushed.current)
    previous.current = openAgent
    if (action === 'push') {
      pushed.current = true
      window.history.pushState(null, '')
    } else if (action === 'back') {
      pushed.current = false
      pendingBacks.current += 1
      window.history.back()
    }
  }, [openAgent])

  useEffect(() => {
    const onPop = (): void => {
      const action = popstateAction(pendingBacks.current, pushed.current)
      if (action === 'settle') {
        pendingBacks.current -= 1
        return
      }
      if (action !== 'close') return
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

/**
 * Whether the list has been scrolled far enough for a way back to the top.
 *
 * Inactive is answered by the `&&`, not by writing `false` into the state. The
 * only thing that deactivates this is the terminal covering the list, and the
 * list keeps its offset underneath (`useDocumentScrollLock`), so the recorded
 * value is still the true one when the terminal closes — zeroing it meant the
 * button blinked out and back in one frame later, when the listener that had
 * just been re-attached measured the same `scrollY` it had before. Reading it
 * through `active` also stops a listener-free render from ever reporting a
 * stale true.
 */
function useScrolledDown(active: boolean): boolean {
  const [down, setDown] = useState(false)
  useEffect(() => {
    if (!active) return
    const update = (): void => setDown(shouldShowBackToTop(window.scrollY))
    update()
    window.addEventListener('scroll', update, { passive: true })
    return () => window.removeEventListener('scroll', update)
  }, [active])
  return active && down
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
  copy: Copy
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
            aria-controls={INBOX_DOM_ID}
            onClick={() => {
              // Both, in this order: the viewport moves for the eye, focus
              // moves for the rotor. Scrolling alone leaves a screen-reader
              // user exactly where they were, in the header they just left.
              document.getElementById(INBOX_DOM_ID)?.scrollIntoView({ block: 'start' })
              focusTarget(INBOX_DOM_ID)
            }}
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
  orphans,
  drafts,
  setDraft,
  sending,
  setSending,
  expanded,
  setExpanded,
  seenLive,
  showEnded,
  setShowEnded,
  onOpenAgent,
  onJumpToWorkspace,
  paused
}: {
  api: RemoteApi
  copy: Copy
  inbox: readonly InboxEntry[]
  orphans: readonly OrphanDraft[]
  drafts: Drafts
  setDraft: SetDraft
  sending: Sending
  setSending: (key: string, busy: boolean) => void
  expanded: Readonly<Record<string, boolean>>
  setExpanded: React.Dispatch<React.SetStateAction<Record<string, boolean>>>
  seenLive: ReadonlySet<string>
  showEnded: boolean
  setShowEnded: React.Dispatch<React.SetStateAction<boolean>>
  onOpenAgent: (agentId: string) => void
  onJumpToWorkspace: (workspaceId: string) => void
  /** The terminal covers the list: no gestures, no floating controls. */
  paused: boolean
}): React.JSX.Element {
  const pull = usePullToRefresh(api.refresh, !paused)
  const scrolledDown = useScrolledDown(!paused)
  const rows = overviewRows(api.workspaces, seenLive, showEnded)
  const visible = rowWorkspaces(rows)
  const allExpanded = everyCardExpanded(rows, expanded)
  const foldedIds = rows.flatMap((row) =>
    row.kind === 'workspace' && !row.workspace.active && !seenLive.has(row.workspace.workspaceId)
      ? [cardDomId(row.workspace.workspaceId)]
      : []
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
          sending={sending}
          setSending={setSending}
          onJump={onJumpToWorkspace}
        />
        <UnsentDrafts
          copy={copy}
          orphans={orphans}
          workspaces={api.workspaces}
          onDiscard={(key) => setDraft(key, '')}
        />
        <StartForm
          api={api}
          copy={copy}
          drafts={drafts}
          setDraft={setDraft}
          hasLiveRun={hasActiveWorkspace(api.workspaces)}
        />
        {api.workspaces.length === 0 ? (
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
        {/*
          ONE keyed list, cards and divider together. React reconciles each
          child slot on its own, so a second `{ended.map(…)}` beside the first
          would unmount a card the moment its run ended and mount a stranger in
          its place — see `overviewRows`. Everything that must survive a run
          ending (the card's open answers, its stop confirmation, its task
          board, and the user's place in the document) survives because this
          array is the only slot a card ever lives in.
        */}
        {rows.map((row) =>
          row.kind === 'workspace' ? (
            <WorkspaceCard
              key={row.key}
              workspace={row.workspace}
              justEnded={row.justEnded}
              questions={inboxEntriesFor(inbox, row.workspace.workspaceId)}
              expanded={isWorkspaceExpanded(row.workspace, expanded, row.justEnded)}
              onToggle={() =>
                setExpanded((current) => ({
                  ...current,
                  [row.workspace.workspaceId]: !isWorkspaceExpanded(
                    row.workspace,
                    current,
                    row.justEnded
                  )
                }))
              }
              api={api}
              copy={copy}
              drafts={drafts}
              setDraft={setDraft}
              sending={sending}
              setSending={setSending}
              onOpenAgent={onOpenAgent}
            />
          ) : (
            <button
              key={row.key}
              type="button"
              className="ended-toggle"
              aria-expanded={showEnded}
              /* The cards it reveals are its siblings, not a wrapper it could
                 name while collapsed: wrapping them would put them in a second
                 child slot, which is the bug above. So the relationship is
                 stated when it resolves, and the button's own label carries
                 the count when it does not. */
              aria-controls={showEnded ? foldedIds.join(' ') : undefined}
              onClick={() => setShowEnded((current) => !current)}
            >
              {showEnded ? copy.hideEnded : copy.showEnded(row.count)}
            </button>
          )
        )}
      </main>
      {scrolledDown ? (
        <button
          type="button"
          className="to-top"
          aria-label={copy.backToTop}
          onClick={() =>
            window.scrollTo({ top: 0, behavior: scrollBehavior(prefersReducedMotion()) })
          }
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
  sending,
  setSending,
  onJump
}: {
  api: RemoteApi
  copy: Copy
  entries: readonly InboxEntry[]
  drafts: Drafts
  setDraft: SetDraft
  sending: Sending
  setSending: (key: string, busy: boolean) => void
  onJump: (workspaceId: string) => void
}): React.JSX.Element | null {
  if (entries.length === 0) return null
  return (
    <section className="inbox" id={INBOX_DOM_ID} tabIndex={-1} aria-labelledby="inbox-title">
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
            sending={sending}
            setSending={setSending}
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
 * Text the user typed into a field that no longer exists.
 *
 * Two ordinary things produce it: a question answered from the desktop takes
 * its answer field down mid-sentence, and a run ending takes its composer.
 * Both used to happen in silence — the words simply left the screen while
 * still sitting in the draft map, unreachable and unsendable. They are shown
 * here instead, next to what they were for, until the user discards them.
 * Read-only on purpose: there is nothing left to send them to, and a field
 * that looks like it would send is a worse lie than no field.
 */
function UnsentDrafts({
  copy,
  orphans,
  workspaces,
  onDiscard
}: {
  copy: Copy
  orphans: readonly OrphanDraft[]
  workspaces: readonly RemoteWorkspaceSummary[]
  onDiscard: (key: string) => void
}): React.JSX.Element | null {
  if (orphans.length === 0) return null
  const nameOf = (workspaceId: string | undefined): string | undefined =>
    workspaces.find((workspace) => workspace.workspaceId === workspaceId)?.name
  return (
    <section className="unsent" aria-labelledby="unsent-title">
      <h2 className="inbox-title" id="unsent-title">
        <span>{copy.unsentTitle}</span>
      </h2>
      {orphans.map((orphan) => {
        const name = nameOf(orphan.workspaceId)
        const source = !name
          ? copy.unsentElsewhere
          : orphan.kind === 'composer'
            ? copy.unsentComposer(name)
            : copy.unsentAnswer(name)
        return (
          <article className="unsent-entry" key={orphan.key}>
            <p className="inbox-source">{source}</p>
            <p className="unsent-text">{orphan.text}</p>
            <button
              type="button"
              className="ghost-inline"
              onClick={() => onDiscard(orphan.key)}
            >
              {copy.discardDraft}
            </button>
          </article>
        )
      })}
    </section>
  )
}

/**
 * Start a workspace from the phone — profile picker plus the goal field (H2).
 * Without a goal the start stays allowed (back-compat); the card below then
 * says so. Closed by default while a run is already live so the list can
 * scroll to the work — but once the user has opened or closed it themselves,
 * that decision outranks the default, which is why `openedByUser` is
 * tri-state (see `startFormOpen`).
 *
 * A button and a panel, not `<details open={…}>`. `toggle` fires for ANY
 * change to the `open` attribute, React's own included, so a workspace started
 * from the desktop would flip `hasLiveRun`, close the form under the user's
 * thumb, and then record that close as the user's own decision — pinning a
 * form shut that they never touched. A disclosure the component drives has no
 * such second channel.
 */
function StartForm({
  api,
  copy,
  drafts,
  setDraft,
  hasLiveRun
}: {
  api: RemoteApi
  copy: Copy
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

  /**
   * The `api` the fetch below reaches for, kept current without becoming a
   * dependency of it — the same device the terminal uses, for a reason worth
   * writing down rather than asserting in a comment.
   *
   * `api` is a fresh object on every render of `App`, so `[ready, api]` would
   * re-issue `profiles:list` on every workspace push, every liveness probe and
   * every keystroke that reaches `App` — a command per frame down a socket the
   * user is trying to type into. `[ready]` alone is the right trigger: the
   * list is fetched when the connection becomes usable and does not change
   * again until it stops being usable.
   *
   * What made the same omission a bug in `RemoteTerminal` was that the stale
   * capture there was READ long after it was taken. This one is not: every
   * member of `api` that `runCommand` touches lives behind a ref inside
   * `useRemote` (the socket, the locale, the pending map), so it dispatches
   * down whatever route is live at the moment it is called, and the call
   * happens in the same commit the capture came from. The ref makes that
   * structural instead of a claim — if `runCommand` ever does close over
   * render state, this reads the version that owns it.
   */
  const apiRef = useRef(api)
  useEffect(() => {
    apiRef.current = api
  })

  useEffect(() => {
    if (!ready) return
    apiRef.current.runCommand('profiles:list').then(
      (result) => {
        const list = Array.isArray(result) ? (result as RemoteProfileSummary[]) : []
        setProfiles(list)
        // A profile deleted on the desktop must not stay selected: the
        // `<select>` would show the first option while the start still carried
        // the old id, and the run would fail with a raw gateway error about an
        // id the user cannot see anywhere on the screen.
        setProfileId((current) => keepSelectedProfile(current, list))
      },
      () => setProfiles([])
    )
  }, [ready])

  if (!ready || profiles.length === 0) return null

  const open = startFormOpen(openedByUser, hasLiveRun, goal.trim().length > 0)

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
    <section className="card start-card">
      <button
        type="button"
        className="card-toggle start-summary"
        aria-expanded={open}
        aria-controls="start-form-body"
        onClick={() => setOpenedByUser(!open)}
      >
        <span className="card-name">{copy.newWorkspace}</span>
      </button>
      <div id="start-form-body" className="start-body" hidden={!open}>
        {open ? (
          <>
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
            <LimitedTextarea
              className="goal-input"
              rows={3}
              placeholder={copy.goalPlaceholder}
              ariaLabel={copy.goalPlaceholder}
              value={goal}
              copy={copy}
              enterKeyHint="enter"
              onChange={(value) => setDraft(GOAL_DRAFT_KEY, value)}
            />
            {error ? <p className="form-error">{error}</p> : null}
            <button className="primary" type="button" disabled={busy} onClick={start}>
              {busy ? copy.starting : goal.trim() ? copy.startWithGoal : copy.startWithoutGoal}
            </button>
          </>
        ) : null}
      </div>
    </section>
  )
}

/**
 * A textarea that cannot silently overrun the wire.
 *
 * `protocol.ts` caps an `args` value at 20 000 characters and the server's
 * validator rejects the whole frame past it — so a long paste used to leave
 * the user with a full field, a button that appeared to work, and nothing
 * happening. `maxLength` makes the browser refuse the excess at the moment of
 * the paste, and the note says so rather than leaving the truncation to be
 * discovered later.
 */
function LimitedTextarea({
  className,
  rows,
  placeholder,
  ariaLabel,
  ariaLabelledBy,
  value,
  copy,
  enterKeyHint,
  onChange,
  onKeyDown
}: {
  className?: string
  rows: number
  placeholder: string
  ariaLabel?: string
  ariaLabelledBy?: string
  value: string
  copy: Copy
  enterKeyHint: 'enter' | 'send'
  onChange: (value: string) => void
  onKeyDown?: React.KeyboardEventHandler<HTMLTextAreaElement>
}): React.JSX.Element {
  return (
    <>
      <textarea
        className={className}
        rows={rows}
        placeholder={placeholder}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        value={value}
        maxLength={ARG_MAX_CHARS}
        enterKeyHint={enterKeyHint}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {value.length >= ARG_MAX_CHARS ? (
        <p className="form-error" role="status">
          {copy.lengthLimit(ARG_MAX_CHARS)}
        </p>
      ) : null}
    </>
  )
}

function WorkspaceCard({
  workspace,
  justEnded,
  questions,
  expanded,
  onToggle,
  api,
  copy,
  drafts,
  setDraft,
  sending,
  setSending,
  onOpenAgent
}: {
  workspace: RemoteWorkspaceSummary
  /** Ended while this client was watching — see `overviewRows`. */
  justEnded: boolean
  questions: readonly InboxEntry[]
  expanded: boolean
  onToggle: () => void
  api: RemoteApi
  copy: Copy
  drafts: Drafts
  setDraft: SetDraft
  sending: Sending
  setSending: (key: string, busy: boolean) => void
  onOpenAgent: (agentId: string) => void
}): React.JSX.Element {
  const [openAnswers, setOpenAnswers] = useState<Record<string, boolean>>({})
  const [confirmStop, setConfirmStop] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [stopError, setStopError] = useState<string | null>(null)
  // Held here, not in `TaskBoard`: the card body is only built while the card
  // is open, so a flag living down there would be forgotten by the collapse.
  const [tasksOpen, setTasksOpen] = useState(false)
  const goalLine = workspaceGoalLine(workspace, copy)
  const bodyId = `${cardDomId(workspace.workspaceId)}-body`

  /*
   * The only destructive control on the screen, and until now the only one
   * that threw its answer away: a bare `runCommand` with no handlers left a
   * failed stop as an unhandled rejection while the user walked off believing
   * the run had ended. It reports both ways now — the button says it is
   * working, and a refusal is on the card in words. Success needs no notice
   * of its own: the card goes inactive on the next push, which is the truth
   * arriving rather than a claim about it.
   */
  const stop = (): void => {
    if (stopping) return
    haptic('warn')
    setStopping(true)
    setStopError(null)
    api.runCommand('workspaces:stop', workspace.workspaceId).then(
      () => {
        setStopping(false)
        setConfirmStop(false)
      },
      (cause: Error) => {
        setStopping(false)
        setConfirmStop(false)
        setStopError(cause.message)
      }
    )
  }

  return (
    <section
      className={`${workspaceCardClass(workspace, expanded)}${justEnded ? ' is-just-ended' : ''}`}
      id={cardDomId(workspace.workspaceId)}
      tabIndex={-1}
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
          {/* A collapsed card with an open question was a silent pulse — a
              dot with no name, invisible to anyone reading the screen. */}
          {!expanded && questions.length > 0 ? (
            <span
              className="card-attention"
              role="img"
              aria-label={copy.inboxCount(questions.length)}
            />
          ) : null}
        </button>
        {workspace.active ? (
          confirmStop ? (
            <span className="stop-confirm">
              <button
                type="button"
                className="stop is-confirm"
                disabled={stopping}
                onClick={stop}
              >
                {stopping ? copy.stopping : copy.stopConfirm}
              </button>
              <button
                type="button"
                className="ghost-inline"
                disabled={stopping}
                onClick={() => setConfirmStop(false)}
              >
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
          <span className="inactive-tag">{justEnded ? copy.justEnded : copy.inactive}</span>
        )}
      </div>
      {stopError ? (
        <p className="form-error" role="status">
          {stopError}
        </p>
      ) : null}
      {/* The wrapper stays in the DOM so `aria-controls` always resolves; the
          body itself is only built when it is on screen. */}
      <div id={bodyId} hidden={!expanded}>
        {expanded ? (
          <>
            {/* Said in words, in the body, because the run ending under the
                user is the moment the card is most likely to be read and least
                likely to be understood from a colour change alone. */}
            {justEnded ? <p className="card-task ended-note">{copy.endedWhileHere}</p> : null}
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
                    sending={sending}
                    setSending={setSending}
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
                      question={question}
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
                      <div className="answer-form" id={answerPanelDomId(question.key)}>
                        <AnswerForm
                          api={api}
                          copy={copy}
                          entry={question}
                          drafts={drafts}
                          setDraft={setDraft}
                          sending={sending}
                          setSending={setSending}
                          idPrefix="card"
                          onDismiss={() => {
                            // Focus first: the click below is about to unmount
                            // the button that carries it, and focus that falls
                            // on nothing puts a keyboard or screen-reader user
                            // back at the top of the document.
                            focusTarget(askBadgeDomId(question.key))
                            setOpenAnswers((current) => ({ ...current, [question.key]: false }))
                          }}
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
  copy: Copy
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
  sending,
  setSending,
  idPrefix,
  onDismiss
}: {
  api: RemoteApi
  copy: Copy
  entry: InboxEntry
  drafts: Drafts
  setDraft: SetDraft
  /**
   * In flight, keyed by question rather than by form. One `ask_user` is
   * mounted TWICE — once in the inbox, once on its card — and a `busy` flag
   * held locally left the other copy live: sending from both produced a second
   * `answer_question` for a question the registry had already closed, which
   * comes back as `unknown_question` and reads to the user as their answer
   * having failed.
   */
  sending: Sending
  setSending: (key: string, busy: boolean) => void
  /** Two mounted copies of one question must not share a DOM id. */
  idPrefix: string
  onDismiss?: () => void
}): React.JSX.Element {
  const [error, setError] = useState<string | null>(null)
  const busy = sending[entry.key] === true
  const draftKey = answerDraftKey(entry.key)
  const text = drafts[draftKey] ?? ''
  const promptId = `${idPrefix}-${entry.key}`

  const submit = (): void => {
    const trimmed = text.trim()
    if (!trimmed || busy) return
    setSending(entry.key, true)
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
          setSending(entry.key, false)
          setDraft(draftKey, '')
          haptic('confirm')
        },
        (cause: Error) => {
          setError(cause.message)
          setSending(entry.key, false)
        }
      )
  }

  return (
    <>
      <p className="answer-question" id={promptId}>
        {inboxPrompt(entry, copy)}
      </p>
      <LimitedTextarea
        className="goal-input"
        rows={3}
        placeholder={copy.answerPlaceholder}
        ariaLabelledBy={promptId}
        value={text}
        copy={copy}
        enterKeyHint="send"
        onChange={(value) => setDraft(draftKey, value)}
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
  copy: Copy
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
      <LimitedTextarea
        rows={2}
        placeholder={copy.composerPlaceholder}
        ariaLabel={copy.composerPlaceholder}
        value={text}
        copy={copy}
        enterKeyHint="send"
        onChange={(value) => setDraft(draftKey, value)}
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
  question,
  answerOpen,
  onOpen,
  onToggleAnswer
}: {
  agent: RemoteAgentSummary
  copy: Copy
  question: InboxEntry | undefined
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
        // Validated, not forwarded: this is the one place a string off the
        // socket reaches a style attribute — see `safeRoleColor`.
        style={{ '--role': safeRoleColor(agent.roleColor) } as React.CSSProperties}
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
      {question ? (
        <button
          type="button"
          className="badge"
          id={askBadgeDomId(question.key)}
          onClick={onToggleAnswer}
          aria-expanded={answerOpen}
          // Named only while it resolves: the panel is built when it opens.
          aria-controls={answerOpen ? answerPanelDomId(question.key) : undefined}
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
