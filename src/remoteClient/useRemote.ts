/**
 * The remote client's connection layer: pairing, the WebSocket, and the
 * protocol dispatch. One hook, no store library — the same discipline as the
 * desktop panel.
 *
 * Auth: the pairing URL carries the token in the fragment (`#token=…`); this
 * exchanges it for a session over `POST /api/auth`, keeps the session AND the
 * pairing token in `localStorage` (so a phone home-screen bookmark survives
 * a desktop restart), and clears the fragment so a shared screenshot of the
 * URL bar leaks nothing. The WebSocket authenticates with its first frame,
 * then multiplexes workspace state, terminals and commands. If the desktop
 * restarted and in-memory sessions died, the stored pairing token silently
 * mints a new session — the QR does not have to be scanned again.
 *
 * Pairing has to survive the route as well, because the first thing a phone
 * does is open the bookmark before the tailnet is up. A `POST` that never
 * reached a desktop is a fact about the route, not about the token, so it
 * keeps every credential and retries on the socket's own backoff and wake
 * signals (`attemptPairing`); only a desktop that answered and declined may
 * send the user back to the QR code (`decidePairingRecovery`).
 *
 * Staying connected is the hard half, and it is why this hook is bigger than
 * a socket wrapper. A phone sleeps mid-run, walks out of Wi-Fi range, and
 * comes back with a socket the browser still calls `OPEN`. Three mechanisms
 * cover that, all of them policy in `connection.ts`:
 *   - capped exponential backoff for an honest close,
 *   - an immediate reconnect on wake-up (tab visible, network back, bfcache
 *     restore) that resets the backoff instead of waiting out its ceiling,
 *   - a `refresh` round-trip that turns silence into a verdict on a socket
 *     that only looks alive.
 * Every reconnect re-attaches the terminals the UI was watching (see the
 * `hello` case) and the server replays their scrollback, so a reconnect is
 * lossless from the user's side — and, because reconnecting is routine rather
 * than exceptional, each re-attach names the tail it already holds so that
 * replay costs a marker instead of a whole scrollback (`sendAttach`).
 *
 * Commands are lossless across it too, and that is a correctness requirement
 * rather than a nicety: `runCommand` hands the UI a promise, and a promise
 * that never settles is an Answer button stuck on "sending ..." with an agent
 * blocked behind it. So a command issued while the socket is down is QUEUED
 * and flushed on the next `hello` — reconnecting is the normal state of a
 * phone, not an error — while every parked command, queued or in flight,
 * carries a deadline and dies at it. The policy for all of that
 * (`decideCommandDispatch`, `commandsToEvict`, `expiredCommandIds`) is in
 * `connection.ts`; this file is the wiring.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { MAX_RESUME_TAIL_CHARS } from '@shared/remote/limits'
import type {
  RemoteCommand,
  RemoteWorkspaceSummary,
  ServerMessage
} from '@shared/remote/protocol'
import {
  commandArgsWithinLimits,
  commandsToEvict,
  COMMAND_TIMEOUT_MS,
  decideCommandDispatch,
  decideLiveness,
  decidePairingRecovery,
  decideWake,
  expiredCommandIds,
  isSamePayload,
  LIVENESS_TICK_MS,
  offersResumeMarker,
  pairingFailureFromStatus,
  reconnectDelayMs,
  shouldFailParkedCommands,
  shouldScheduleReconnect,
  tokenFromHash,
  type PairingOutcome,
  type PairingSource
} from './connection'
import { remoteCopy } from './i18n'
import { trackWritten } from './terminalAttach'

export type RemotePhase = 'pairing' | 'connecting' | 'ready' | 'error' | 'revoked'

/**
 * Machine-readable error causes. The hook does not localize its phases — the
 * view maps these onto `RemoteCopy` fields (by this exact name) so the message
 * follows the active locale.
 *
 * The two are not variants of one message. `pairingFailed` is the desktop
 * declining a token and ends at the QR code; `unreachable` is a request that
 * never reached a desktop, keeps every credential, and is being retried in the
 * background while it is on screen.
 */
export type RemoteError = 'pairingFailed' | 'unreachable'

const SESSION_KEY = 'vertragus.remote.session'
const PAIRING_KEY = 'vertragus.remote.pairing'

export interface TerminalHandlers {
  /**
   * The agent's scrollback as the bridge holds it, plus its identity and —
   * the part a live-looking dot depends on — whether the process behind it is
   * already dead. `exitCode` is `null` for a running PTY and the code it left
   * with otherwise; a PTY that died before this client ever attached fires no
   * `exit` frame, so the snapshot is the ONLY place that news arrives.
   *
   * `snapshot` may be a resumed view of the stream rather than the whole
   * scrollback (see `sendAttach`), but it always contains the tail this client
   * already holds, so aligning on that tail and appending what follows is
   * correct either way.
   */
  onSnapshot(
    snapshot: string,
    cols: number,
    rows: number,
    name: string,
    roleColor: string,
    exitCode: number | null
  ): void
  onData(data: string): void
  onExit(exitCode: number | null): void
}

export interface RemoteApi {
  phase: RemotePhase
  error: RemoteError | null
  workspaces: RemoteWorkspaceSummary[]
  theme: 'dark' | 'light'
  locale: string
  /** navigator.onLine, kept live — the header can say "offline" instead of
   *  spinning on a reconnect that cannot succeed. */
  online: boolean
  /**
   * True while a liveness probe is outstanding: the socket still says `OPEN`,
   * but the route has not answered since the probe went out and has at most
   * `LIVENESS_PROBE_TIMEOUT_MS` to do so.
   *
   * `phase` cannot express this. It stays `'ready'` right through the silence
   * window and the probe window, so a header keyed on `phase` alone claims
   * "connected" for up to forty seconds on a route that is already dead. This
   * is the part of that window the client actually has evidence about — while
   * it is true the honest label is "checking", not "connected".
   */
  probing: boolean
  attach(agentId: string, handlers: TerminalHandlers): () => void
  sendInput(agentId: string, data: string): void
  /*
   * No `resize` here on purpose. The PTY is the desktop's, sized by the
   * desktop window; the phone renders whatever size the snapshot names
   * (`TerminalReader.tsx`) and never asks the shared process to reshape.
   */
  /**
   * Run one allow-listed gateway command. Resolves with the command's result
   * and rejects with the gateway's error text — the start form and the answer
   * field need that feedback; fire-and-forget callers may ignore the promise.
   */
  runCommand(name: RemoteCommand, arg?: string, args?: Record<string, string>): Promise<unknown>
  /**
   * Ask for fresh workspace state. Doubles as a liveness verdict: the answer is
   * a `workspaces` push, so a pull-to-refresh on a socket that only looks open
   * either updates the list or convicts the route within the probe window. On
   * a socket that is closed or closing it reconnects instead of dropping the
   * frame on the floor.
   */
  refresh(): void
  /**
   * True while a pairing exchange is on the wire. The `'unreachable'` screen
   * retries on its own, so this is what tells the user the button they are
   * looking at is already doing something.
   */
  retrying: boolean
  /**
   * Try a pairing attempt that failed on the route again, now, from the top of
   * the backoff. A no-op when nothing is waiting to be retried — the manual
   * twin of the wake-ups that already do this.
   */
  retryPairing(): void
  /** Re-pair from scratch (session revoked or expired). */
  reset(): void
}

function readStored(key: string): string | undefined {
  return window.localStorage.getItem(key) ?? window.sessionStorage.getItem(key) ?? undefined
}

function writeSession(session: string): void {
  window.localStorage.setItem(SESSION_KEY, session)
  window.sessionStorage.removeItem(SESSION_KEY)
}

function writePairing(token: string): void {
  window.localStorage.setItem(PAIRING_KEY, token)
}

function clearSession(): void {
  window.localStorage.removeItem(SESSION_KEY)
  window.sessionStorage.removeItem(SESSION_KEY)
}

function clearAuth(): void {
  clearSession()
  window.localStorage.removeItem(PAIRING_KEY)
}

/**
 * Exchange a pairing token for a session, and say which KIND of failure it was
 * when it does not.
 *
 * `fetch` rejects only for a request that never got an answer — no route to
 * the tailnet, DNS gone, the connection dropped mid-body. On a phone that is
 * not an exception, it is what opening the home-screen bookmark before the
 * tailnet is up looks like, so it must not be collapsed into "the desktop said
 * no". A body that will not parse is the same class of problem wearing a 200:
 * this endpoint answers JSON, so HTML here is a captive portal in the way.
 */
async function requestPairing(token: string): Promise<PairingOutcome> {
  let response: Response
  try {
    response = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairingToken: token })
    })
  } catch {
    return { kind: 'unreachable' }
  }
  if (!response.ok) return { kind: pairingFailureFromStatus(response.status) }
  let body: { session?: string }
  try {
    body = (await response.json()) as { session?: string }
  } catch {
    return { kind: 'unreachable' }
  }
  return body.session ? { kind: 'paired', session: body.session } : { kind: 'rejected' }
}

/** One command promise the UI is waiting on. */
interface ParkedCommand {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  /**
   * The frame, while it is still waiting for a socket; `null` once it has been
   * sent. The distinction decides what a close event may settle: a frame that
   * never went out survives the close and is flushed on the next `hello`,
   * while one already on the wire is lost with the socket.
   */
  frame: object | null
  /** Deadline after which the promise is rejected rather than left parked. */
  expiresAt: number
}

export function useRemote(): RemoteApi {
  const [phase, setPhase] = useState<RemotePhase>('connecting')
  const [error, setError] = useState<RemoteError | null>(null)
  const [workspaces, setWorkspaces] = useState<RemoteWorkspaceSummary[]>([])
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  const [locale, setLocale] = useState('de')
  const [online, setOnline] = useState(() => window.navigator.onLine)
  const [probing, setProbing] = useState(false)
  const [retrying, setRetrying] = useState(false)

  const socketRef = useRef<WebSocket | null>(null)
  const sessionRef = useRef<string | null>(null)
  const terminalHandlers = useRef(new Map<string, TerminalHandlers>())
  const attachedAgents = useRef(new Set<string>())
  const reconnectAttempt = useRef(0)
  const reconnectTimer = useRef<number | null>(null)
  const aliveRef = useRef(true)
  /**
   * When the last frame arrived. Zero until `connect()` opens a socket and
   * stamps it — never read before then, because `decideLiveness` refuses to
   * judge a socket that is not `OPEN` and there is no such socket until
   * `connect()` has run. Deliberately not `Date.now()` in the initializer: that
   * argument is evaluated on EVERY render and its value discarded on all but
   * the first, which is an impure call during render for no gain.
   */
  const lastInboundAt = useRef(0)
  const probeSentAt = useRef<number | null>(null)
  /**
   * Per attached agent, the tail of the output this client has already been
   * given — the resume marker the next `attach` offers the bridge.
   *
   * Tracked HERE rather than in the terminal component because this hook is
   * the wire: every byte the component writes came through `onSnapshot` and
   * `onData`, so the tail of what was dispatched is the tail of what was
   * written. The component keeps its own, shorter tail to align on
   * (`OVERLAP_TAIL_CHARS`, half of {@link MAX_RESUME_TAIL_CHARS}), and because
   * both are suffixes of the same stream the shorter is always contained in
   * the longer — which is what makes a resumed snapshot alignable.
   */
  const resumeTails = useRef(new Map<string, string>())
  /**
   * The protocol dispatch and the reconnect entry point, as refs.
   *
   * A socket is a long-lived external subscription: its handlers must call the
   * CURRENT dispatch, and the reconnect timer the current `connect`. Reaching
   * for the values directly would put `dispatch` in `connect`'s dependencies
   * and `connect` inside its own body, which is both a use-before-declaration
   * and a real hazard — every identity change downstream of `dispatch` would
   * ripple through `adoptSession` and `beginPairing` into the mount effect and
   * tear the live connection down to rebuild it. Through refs, `connect` and
   * everything above it are stable for the hook's whole life, which is what the
   * mount effect has always claimed to rely on.
   */
  const dispatchRef = useRef<(message: ServerMessage) => void>(() => undefined)
  const connectRef = useRef<() => void>(() => undefined)
  /**
   * The pairing attempt that is waiting to be tried again — the token and
   * which door it came in by — plus its backoff timer, its attempt count, and
   * whether a request is on the wire right now.
   *
   * A pairing attempt that failed because nothing answered is the same
   * situation as a closed socket one layer earlier: there is a credential that
   * is probably fine and a route that is not. So it gets the same treatment —
   * a capped backoff, cut short by the same wake signals — instead of the
   * spinner that never resolved.
   */
  const pendingPairing = useRef<{ token: string; source: PairingSource } | null>(null)
  const pairingTimer = useRef<number | null>(null)
  const pairingAttempt = useRef(0)
  const pairingInFlight = useRef(false)
  /** `attemptPairing`, for the retry it schedules for itself. See `connectRef`. */
  const attemptPairingRef = useRef<(token: string, source: PairingSource) => void>(() => undefined)
  /**
   * The locale as a ref: a command rejects from inside a socket callback that
   * closed over the render it was created in, and a German error on an English
   * phone is exactly the leak the i18n layer exists to prevent.
   */
  const localeRef = useRef(locale)
  /**
   * Every command promise the UI is still waiting on, queued or in flight, in
   * the order it was issued (a `Map` keeps insertion order, which is what makes
   * the queue bound drop the OLDEST tap).
   */
  const pendingCommands = useRef(new Map<string, ParkedCommand>())
  const commandSeq = useRef(0)
  /**
   * Bumped by every deliberate auth change — a `reset()`, a server-initiated
   * revoke. Anything that resumed after an `await` compares the generation it
   * captured against this before touching storage or the socket: without that
   * guard an in-flight `requestPairing()` can land after the user has logged
   * out and write the session AND the pairing token straight back into
   * `localStorage`, turning a log-out into a re-authentication. It is not the
   * whole guard: see `cancelPairingRetry` for the retry that is not in flight
   * yet.
   */
  const authGeneration = useRef(0)

  useEffect(() => {
    localeRef.current = locale
  }, [locale])

  const sendRaw = useCallback((message: object) => {
    const socket = socketRef.current
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
  }, [])

  /** Ask for a workspace push and start the clock on the answer. */
  const probe = useCallback(() => {
    if (socketRef.current?.readyState !== WebSocket.OPEN) return
    probeSentAt.current = Date.now()
    setProbing(true)
    sendRaw({ type: 'refresh' })
  }, [sendRaw])

  /**
   * Ask the bridge for an agent's stream, saying where this client already is.
   *
   * The marker is what makes a reconnect cheap: without it every re-attach
   * ships the whole scrollback (up to 2 MB per agent), and this client
   * reconnects on a liveness verdict, on `visibilitychange`, on `pageshow` and
   * on `online` — routinely, by design. With it the bridge answers from the
   * marker on. It is only ever a hint; a bridge that cannot place it replays
   * everything, which is the behaviour that predates it.
   */
  const sendAttach = useCallback(
    (agentId: string) => {
      const resume = resumeTails.current.get(agentId)
      sendRaw(
        offersResumeMarker(resume)
          ? { type: 'attach', agentId, resume }
          : { type: 'attach', agentId }
      )
    },
    [sendRaw]
  )

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimer.current === null) return
    window.clearTimeout(reconnectTimer.current)
    reconnectTimer.current = null
  }, [])

  const clearPairingTimer = useCallback(() => {
    if (pairingTimer.current === null) return
    window.clearTimeout(pairingTimer.current)
    pairingTimer.current = null
  }, [])

  /**
   * Forget the pairing attempt that was waiting to be retried.
   *
   * Every deliberate auth change has to call this, not just bump the
   * generation: the generation stops an attempt that is already in flight from
   * writing its result, but a retry still sitting on its backoff timer would
   * start a NEW attempt afterwards — capturing the new generation, passing its
   * own guard, and re-authenticating from a token the user just revoked.
   */
  const cancelPairingRetry = useCallback(() => {
    clearPairingTimer()
    pendingPairing.current = null
    pairingAttempt.current = 0
    setRetrying(false)
  }, [clearPairingTimer])

  /** Reject the named commands and forget them. */
  const rejectCommands = useCallback((ids: Iterable<string>, message: string) => {
    for (const id of ids) {
      const parked = pendingCommands.current.get(id)
      if (!parked) continue
      pendingCommands.current.delete(id)
      parked.reject(new Error(message))
    }
  }, [])

  /**
   * A socket that goes away takes the commands already ON it with it. The ones
   * still queued do not die with it — they were never sent, and the whole point
   * of the queue is that they survive the reconnect they are waiting for.
   */
  const failPendingCommands = useCallback(() => {
    const message = remoteCopy(localeRef.current).connectionLost
    const inFlight: string[] = []
    for (const [id, parked] of pendingCommands.current) {
      if (parked.frame === null) inFlight.push(id)
    }
    rejectCommands(inFlight, message)
  }, [rejectCommands])

  /**
   * Reject whatever has outlived its deadline — queued or in flight.
   *
   * `connectionLost` and not a timeout of its own, because of what the numbers
   * make true: `COMMAND_TIMEOUT_MS` (45 s) is longer than the liveness rule
   * needs to convict a dead route and reconnect (40 s), so anything still
   * unanswered here has either spent that time with no socket to go out on or
   * outlived a route that was replaced under it. The one case the string
   * overclaims is a live socket that silently dropped a malformed frame — which
   * `commandArgsWithinLimits` exists to prevent, and which is a bug in this
   * client rather than a state the user can be in.
   */
  const expireCommands = useCallback(() => {
    const expired = expiredCommandIds(pendingCommands.current, Date.now())
    if (expired.length === 0) return
    rejectCommands(expired, remoteCopy(localeRef.current).connectionLost)
  }, [rejectCommands])

  /**
   * Put the queue on the wire, oldest first. Called when `hello` proves it.
   *
   * The deadline is NOT restarted here, and that is the whole point of where it
   * is set: `COMMAND_TIMEOUT_MS` is a claim about how long the person who
   * tapped will wait, and `connection.test.ts` pins it against exactly that
   * ("inside the patience of someone holding a phone"). Restarting the clock at
   * flush time would make queued-then-flushed cost 45 s + 45 s, so the number
   * under test and the number the user experiences would be different numbers.
   * The cost is real but small: a command flushed in the last second of its
   * life is rejected a second later even though its answer was on its way.
   */
  const flushCommandQueue = useCallback(() => {
    for (const parked of pendingCommands.current.values()) {
      if (parked.frame === null) continue
      const frame = parked.frame
      // Marked sent BEFORE the write: `sendRaw` can only fail by dropping the
      // frame, and a frame recorded as queued but already written would be
      // sent twice on the next flush.
      parked.frame = null
      sendRaw(frame)
    }
  }, [sendRaw])

  /**
   * Keep the previous array when a push says nothing new. The liveness probe
   * answers with a full `workspaces` frame on a schedule, and the overview
   * derives its ordering, its question inbox and its task board from that
   * array's identity — see `isSamePayload`.
   */
  const applyWorkspaces = useCallback((next: RemoteWorkspaceSummary[]) => {
    setWorkspaces((previous) => (isSamePayload(previous, next) ? previous : next))
  }, [])

  const connect = useCallback(() => {
    const session = sessionRef.current
    if (!session) return
    clearReconnectTimer()
    // A wake-up or a liveness verdict can land while an earlier socket is still
    // around. Drop it deliberately and clear `socketRef` first: that ref is the
    // identity every handler checks, so the orphan's `onclose` becomes a no-op
    // and cannot schedule a second reconnect behind this one.
    const orphan = socketRef.current
    socketRef.current = null
    if (orphan) {
      orphan.close()
      failPendingCommands()
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws`)
    socketRef.current = socket
    setPhase('connecting')
    lastInboundAt.current = Date.now()
    probeSentAt.current = null
    setProbing(false)

    socket.onopen = () => socket.send(JSON.stringify({ type: 'auth', session }))
    socket.onmessage = (event) => {
      // The same identity check `onclose` makes, and for a sharper reason.
      // `connect()` orphans the previous socket by clearing `socketRef` before
      // closing it, and a frame already queued on that socket still fires its
      // message event afterwards — closing a WebSocket does not un-queue what
      // has arrived. Without this guard that frame is dispatched into the
      // replacement's stream: a `data` chunk the replacement's own snapshot
      // already carried is appended a second time (a visibly duplicated block,
      // now that a re-attach appends rather than resets), a stale `hello`
      // flushes the command queue against a socket that is still CONNECTING so
      // the frames are dropped while the promises count as sent, and the
      // liveness stamps below credit the new route with the old one's traffic.
      if (socketRef.current !== socket) return
      // Any frame is proof of life, whichever probe or push produced it.
      lastInboundAt.current = Date.now()
      probeSentAt.current = null
      // Functional form so React bails out instead of re-rendering the whole
      // overview on every terminal `data` frame.
      setProbing((outstanding) => (outstanding ? false : outstanding))
      try {
        dispatchRef.current(JSON.parse(event.data as string) as ServerMessage)
      } catch {
        // A malformed frame from our own server is not worth crashing the UI.
      }
    }
    socket.onclose = () => {
      const context = {
        isCurrent: socketRef.current === socket,
        alive: aliveRef.current,
        hasSession: sessionRef.current !== null
      }
      // The ref is the identity every other handler checks; a socket that has
      // closed must not stay in it, whatever else follows.
      if (context.isCurrent) socketRef.current = null
      if (shouldFailParkedCommands(context)) failPendingCommands()
      if (!shouldScheduleReconnect(context)) return
      const delay = reconnectDelayMs(reconnectAttempt.current)
      reconnectAttempt.current += 1
      setPhase('connecting')
      reconnectTimer.current = window.setTimeout(() => {
        reconnectTimer.current = null
        if (aliveRef.current && sessionRef.current) connectRef.current()
      }, delay)
    }
    // No identity guard here: this closes the socket it was installed on, and
    // closing an already-closed socket is a no-op. An orphan's error tears down
    // an orphan, which is what `connect()` asked for anyway.
    socket.onerror = () => socket.close()
  }, [clearReconnectTimer, failPendingCommands])

  /** Reconnect now, from the top of the backoff schedule. */
  const reconnectNow = useCallback(() => {
    reconnectAttempt.current = 0
    connect()
  }, [connect])

  const adoptSession = useCallback(
    (session: string, pairingToken?: string) => {
      writeSession(session)
      if (pairingToken) writePairing(pairingToken)
      sessionRef.current = session
      connect()
    },
    [connect]
  )

  /**
   * One pass at exchanging a pairing token for a session, and whatever the
   * outcome calls for — including scheduling the next pass.
   *
   * The decision itself is `decidePairingRecovery`, in `connection.ts` and
   * under test there, because the interesting part is not the fetch: it is
   * that only a desktop which ANSWERED may cost the user their stored
   * credentials. A request that never arrived leaves the token where it is and
   * comes back to it, because the phone is not unpaired, it is out of range.
   */
  const attemptPairing = useCallback(
    async (token: string, source: PairingSource): Promise<void> => {
      // One at a time: a wake-up can land on top of an attempt that is already
      // on the wire, and two exchanges of the same token race to adopt two
      // sessions of which one is immediately orphaned.
      if (!aliveRef.current || pairingInFlight.current) return
      clearPairingTimer()
      // Recorded before the request, so a wake-up or a `reset()` that lands
      // mid-flight knows there is an attempt to hurry along or to cancel.
      pendingPairing.current = { token, source }
      // Captured before the `await`: a `reset()` or a revoke while the request
      // is in flight makes everything below a decision about an auth state
      // that no longer exists.
      const generation = authGeneration.current
      pairingInFlight.current = true
      setRetrying(true)
      const outcome = await requestPairing(token)
      pairingInFlight.current = false
      if (!aliveRef.current || authGeneration.current !== generation) return
      setRetrying(false)
      if (outcome.kind === 'paired') {
        pendingPairing.current = null
        pairingAttempt.current = 0
        setError(null)
        adoptSession(outcome.session, token)
        return
      }
      switch (decidePairingRecovery(outcome.kind, source)) {
        case 'retry': {
          // The socket's backoff schedule, for the same reason it has one: the
          // first retry usually wins, and the ceiling keeps a phone in a
          // tunnel from spending its battery on a route that is not there.
          // `wake` cuts the wait short when the phone walks back into range,
          // so recovering costs no tap.
          const delay = reconnectDelayMs(pairingAttempt.current)
          pairingAttempt.current += 1
          setError('unreachable')
          setPhase('error')
          pairingTimer.current = window.setTimeout(() => {
            pairingTimer.current = null
            if (!aliveRef.current || authGeneration.current !== generation) return
            attemptPairingRef.current(token, source)
          }, delay)
          break
        }
        case 'showPairingFailed':
          cancelPairingRetry()
          setError('pairingFailed')
          setPhase('error')
          break
        case 'forgetPairing':
          cancelPairingRetry()
          // Only here, where the desktop answered and declined the token: the
          // stored one is spent, and the QR code is the way back.
          window.localStorage.removeItem(PAIRING_KEY)
          setPhase('pairing')
          break
        case 'revoke':
          cancelPairingRetry()
          clearAuth()
          setPhase('revoked')
          break
      }
    },
    [adoptSession, cancelPairingRetry, clearPairingTimer]
  )

  useEffect(() => {
    attemptPairingRef.current = (token, source) => void attemptPairing(token, source)
  }, [attemptPairing])

  /**
   * Try the paused pairing attempt again now, from the top of the backoff.
   *
   * A PAUSED attempt: an exchange already on the wire is not waiting for
   * anything and cannot be hurried, so it is left alone. The in-flight check
   * has to happen here rather than inside `attemptPairing`, which returns
   * early in that case — before this reset, `wake()` fires on every
   * `visibilitychange`, `pageshow` and `online`, so a phone churning wake
   * signals during one slow fetch zeroed the counter over and over and the
   * backoff never grew past its first step, on a route that was not there.
   */
  const retryPairing = useCallback(() => {
    const pending = pendingPairing.current
    if (!pending || !aliveRef.current || pairingInFlight.current) return
    pairingAttempt.current = 0
    void attemptPairing(pending.token, pending.source)
  }, [attemptPairing])

  /**
   * Replace a session that expired without anyone deciding to end it — an idle
   * timeout, or a desktop that restarted and lost every in-memory session.
   *
   * Driven straight from the `session_revoked` frame rather than through a
   * counter and an effect: this is a response to an event, and routing it
   * through state made a render the medium for a message that had already
   * arrived. Without a stored pairing token there is nothing to re-mint from
   * and the phone has to be paired again.
   */
  const repair = useCallback(() => {
    const pairing = readStored(PAIRING_KEY)
    if (!pairing) {
      setPhase('revoked')
      return
    }
    setPhase('connecting')
    // A repair that fails on the route must NOT land on the revoked screen: a
    // `session_revoked` can arrive on a link that is already coming apart, and
    // "your session ended, scan the QR again" is a lie about a phone that is
    // merely out of range — and one that costs the stored token to tell.
    void attemptPairing(pairing, 'repair')
  }, [attemptPairing])

  const dispatch = useCallback(
    (message: ServerMessage) => {
      switch (message.type) {
        case 'hello':
          applyWorkspaces(message.workspaces)
          setTheme(message.theme)
          setLocale(message.locale)
          setPhase('ready')
          reconnectAttempt.current = 0
          // Re-attach any terminals the UI was watching before a reconnect,
          // each from the point it had already reached.
          for (const agentId of attachedAgents.current) sendAttach(agentId)
          // `hello` is the first proof this socket can carry anything, so it is
          // where the taps made while it was down finally go out.
          flushCommandQueue()
          break
        case 'workspaces':
          applyWorkspaces(message.workspaces)
          break
        case 'snapshot':
          // Replaced, not appended: the frame is the stream up to its own end
          // — the whole scrollback, or the resumed view that begins with the
          // marker this client just sent. Appending would count that echoed
          // marker twice and leave a tail that matches nothing.
          if (resumeTails.current.has(message.agentId)) {
            resumeTails.current.set(
              message.agentId,
              trackWritten('', message.snapshot, MAX_RESUME_TAIL_CHARS)
            )
          }
          terminalHandlers.current
            .get(message.agentId)
            ?.onSnapshot(
              message.snapshot,
              message.cols,
              message.rows,
              message.name,
              message.roleColor,
              message.exitCode
            )
          break
        case 'data': {
          const tail = resumeTails.current.get(message.agentId)
          if (tail !== undefined) {
            resumeTails.current.set(
              message.agentId,
              trackWritten(tail, message.data, MAX_RESUME_TAIL_CHARS)
            )
          }
          terminalHandlers.current.get(message.agentId)?.onData(message.data)
          break
        }
        case 'exit':
          terminalHandlers.current.get(message.agentId)?.onExit(message.exitCode)
          break
        case 'session_revoked':
          sessionRef.current = null
          if (message.reason === 'revoked') {
            // The user revoked THIS device from the desktop. Re-pairing from
            // the stored token would undo that in about a second, which is what
            // made the settings button cosmetic. The pairing token goes with
            // the session, and the client stops here.
            authGeneration.current += 1
            cancelPairingRetry()
            clearAuth()
            setPhase('revoked')
            break
          }
          // Anything else — an expired session, a desktop that restarted and
          // lost its in-memory sessions — is not a decision about this device,
          // so the stored pairing token silently mints a new session.
          clearSession()
          repair()
          break
        case 'command_result': {
          const pending = pendingCommands.current.get(message.id)
          if (pending) {
            pendingCommands.current.delete(message.id)
            if (message.ok) pending.resolve(message.result)
            else pending.reject(new Error(message.error))
          }
          break
        }
        case 'error':
          // Soft errors surface through the workspace push that follows them;
          // nothing to render inline in this minimal client.
          break
      }
    },
    [applyWorkspaces, cancelPairingRetry, flushCommandQueue, repair, sendAttach]
  )
  // The socket handlers read these through refs; keep them current.
  useEffect(() => {
    dispatchRef.current = dispatch
  }, [dispatch])

  useEffect(() => {
    connectRef.current = connect
  }, [connect])

  const beginPairing = useCallback(async () => {
    // Not started from inside the mounting commit (see the effect below), so
    // the hook can already be gone by the time this runs — and the branch that
    // finds a stored session opens a socket with nothing else to guard it.
    if (!aliveRef.current) return
    const token = tokenFromHash(window.location.hash)
    if (token) {
      // Strip the token from the URL before anything can screenshot it. The
      // attempt keeps its own copy, so a retry still has it afterwards.
      history.replaceState(null, '', window.location.pathname + window.location.search)
      await attemptPairing(token, 'link')
      return
    }
    const storedSession = readStored(SESSION_KEY)
    if (storedSession) {
      sessionRef.current = storedSession
      connect()
      return
    }
    const storedPairing = readStored(PAIRING_KEY)
    if (storedPairing) {
      await attemptPairing(storedPairing, 'stored')
      return
    }
    setPhase('pairing')
  }, [attemptPairing, connect])

  useEffect(() => {
    aliveRef.current = true
    /*
     * Started on the microtask queue rather than called here.
     *
     * `beginPairing` is I/O from its first line — the URL fragment, two
     * stores, possibly a `POST` — and its verdict is a phase change. Delivered
     * from inside the commit that mounted this hook, that verdict forces a
     * second render pass before the first paint, for a value that could not
     * have been known any earlier: reading the fragment or `localStorage`
     * during render is exactly the impurity the rules next door forbid. One
     * microtask later it arrives the way every other external event in this
     * hook does — through a callback, batched as an ordinary update. The two
     * branches that already `await` a `fetch` have always behaved this way;
     * this puts the other two on the same footing.
     */
    void Promise.resolve().then(beginPairing)
    return () => {
      aliveRef.current = false
      clearReconnectTimer()
      clearPairingTimer()
      const socket = socketRef.current
      socketRef.current = null
      socket?.close()
      // Parked commands are deliberately NOT rejected here, and it is the one
      // path in this hook that leaves a promise unsettled. `socketRef` is
      // already null, so the close handler's `isCurrent` is false and nothing
      // else will settle them either — but every holder of one of those
      // promises is a component in the tree being unmounted, so there is no
      // one left to tell. Rejecting would only manufacture unhandled
      // rejections out of a page that is going away.
    }
    // Runs once on mount — beginPairing owns the whole connect lifecycle.
  }, [beginPairing, clearPairingTimer, clearReconnectTimer])

  /**
   * Find out where the connection stands, right now, instead of sitting out
   * the rest of a ten-second backoff. Shared by every wake-up (tab visible,
   * network back, bfcache restore) and by the user's own refresh, because they
   * are the same question asked by different means.
   */
  const wake = useCallback(() => {
    if (!aliveRef.current) return
    // A pairing attempt waiting out a backoff is the same question one layer
    // earlier — there is no session yet BECAUSE the route was down — so a
    // wake-up asks it again immediately rather than leaving the phone on the
    // "cannot be reached" screen for the rest of the ceiling.
    if (pendingPairing.current) {
      retryPairing()
      return
    }
    if (!sessionRef.current) return
    switch (decideWake(socketRef.current?.readyState ?? null)) {
      case 'reconnect':
        reconnectNow()
        break
      case 'probe':
        // Doubles as the refresh the overview needs: the answer is a
        // `workspaces` push, so a list frozen since the phone slept updates
        // in the same round-trip that proves the route still carries traffic.
        probe()
        break
      case 'wait':
        break
    }
  }, [probe, reconnectNow, retryPairing])

  // Wake-up: the phone came back, so find out where the connection stands
  // instead of sitting out the rest of a ten-second backoff.
  useEffect(() => {
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') {
        wake()
        return
      }
      // Going away: a probe left outstanding here would still be outstanding
      // on the far side of a throttled interval, minutes old, and the first
      // tick after the wake would read it as a timeout and churn the socket —
      // replaying every attached terminal's scrollback for nothing.
      probeSentAt.current = null
      setProbing(false)
    }
    const onOnline = (): void => {
      setOnline(true)
      wake()
    }
    const onOffline = (): void => setOnline(false)
    document.addEventListener('visibilitychange', onVisibility)
    // `pageshow` also fires for a bfcache restore, where no other event does.
    window.addEventListener('pageshow', wake)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pageshow', wake)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
  }, [wake])

  useEffect(() => {
    const tick = window.setInterval(() => {
      // Rides the liveness interval rather than one timer per command: a
      // deadline that is a few seconds late costs nothing, and a phone does not
      // need N extra timers to keep alive.
      expireCommands()
      const action = decideLiveness({
        now: Date.now(),
        lastInboundAt: lastInboundAt.current,
        probeSentAt: probeSentAt.current,
        visible: document.visibilityState === 'visible',
        open: socketRef.current?.readyState === WebSocket.OPEN
      })
      if (action === 'probe') probe()
      else if (action === 'reconnect') reconnectNow()
    }, LIVENESS_TICK_MS)
    return () => window.clearInterval(tick)
  }, [expireCommands, probe, reconnectNow])

  const attach = useCallback(
    (agentId: string, handlers: TerminalHandlers): (() => void) => {
      terminalHandlers.current.set(agentId, handlers)
      attachedAgents.current.add(agentId)
      // A fresh attach means a blank terminal, so there is nothing to resume
      // from — and the entry's presence is what marks this agent as one whose
      // tail is worth tracking at all.
      resumeTails.current.set(agentId, '')
      sendAttach(agentId)
      return () => {
        terminalHandlers.current.delete(agentId)
        attachedAgents.current.delete(agentId)
        resumeTails.current.delete(agentId)
        sendRaw({ type: 'detach', agentId })
      }
    },
    [sendAttach, sendRaw]
  )

  return {
    phase,
    error,
    workspaces,
    theme,
    locale,
    online,
    probing,
    attach,
    sendInput: (agentId, data) => sendRaw({ type: 'input', agentId, data }),
    runCommand: (name, arg, args) => {
      const copy = remoteCopy(localeRef.current)
      if (!commandArgsWithinLimits(args)) {
        // The gateway drops a frame its schema rejects WITHOUT answering it, so
        // sending this would park a promise nothing can ever settle. Refusing
        // here is the only way the caller learns anything at all — and the
        // refusal says WHICH thing went wrong, because the user can act on
        // "too long" (shorten the paste) and can do nothing at all with
        // "unknown error" about text they are looking at.
        return Promise.reject(new Error(copy.commandTooLong))
      }
      const id = `c${(commandSeq.current += 1)}-${Date.now()}`
      const frame = { type: 'command', id, name, arg, args }
      const promise = new Promise<unknown>((resolve, reject) => {
        // The executor runs synchronously, so the command is parked before
        // anything can answer it.
        const dispatch = decideCommandDispatch({
          open: socketRef.current?.readyState === WebSocket.OPEN
        })
        pendingCommands.current.set(id, {
          resolve,
          reject,
          frame: dispatch === 'queue' ? frame : null,
          expiresAt: Date.now() + COMMAND_TIMEOUT_MS
        })
        if (dispatch === 'send') sendRaw(frame)
      })
      const queued: string[] = []
      for (const [queuedId, parked] of pendingCommands.current) {
        if (parked.frame !== null) queued.push(queuedId)
      }
      rejectCommands(commandsToEvict(queued), copy.connectionLost)
      return promise
    },
    refresh: wake,
    retrying,
    retryPairing,
    reset: () => {
      // A deliberate log-out: anything that resumes after an `await` from here
      // on is answering a question nobody is asking any more.
      authGeneration.current += 1
      clearAuth()
      cancelPairingRetry()
      sessionRef.current = null
      clearReconnectTimer()
      const socket = socketRef.current
      socketRef.current = null
      socket?.close()
      // Everything, queued included — there is no socket left for the queue to
      // wait for, and the drafts the UI is holding must be released.
      rejectCommands([...pendingCommands.current.keys()], remoteCopy(localeRef.current).connectionLost)
      setPhase('pairing')
      setProbing(false)
    }
  }
}
