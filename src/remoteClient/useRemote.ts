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
 * lossless from the user's side.
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
  decideWake,
  expiredCommandIds,
  isSamePayload,
  LIVENESS_TICK_MS,
  reconnectDelayMs,
  shouldFailParkedCommands,
  shouldScheduleReconnect,
  tokenFromHash
} from './connection'
import { remoteCopy } from './i18n'

export type RemotePhase = 'pairing' | 'connecting' | 'ready' | 'error' | 'revoked'

/**
 * Machine-readable error causes. The hook does not localize its phases — the
 * view maps these onto `RemoteCopy` fields so the message follows the active
 * locale.
 */
export type RemoteError = 'pairingFailed'

const SESSION_KEY = 'vertragus.remote.session'
const PAIRING_KEY = 'vertragus.remote.pairing'

export interface TerminalHandlers {
  onSnapshot(snapshot: string, cols: number, rows: number, name: string, roleColor: string): void
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
  resize(agentId: string, cols: number, rows: number): void
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

async function pair(token: string): Promise<string | undefined> {
  const response = await fetch('/api/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pairingToken: token })
  })
  if (!response.ok) return undefined
  const body = (await response.json()) as { session?: string }
  return body.session
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
  const [repairNonce, setRepairNonce] = useState(0)

  const socketRef = useRef<WebSocket | null>(null)
  const sessionRef = useRef<string | null>(null)
  const terminalHandlers = useRef(new Map<string, TerminalHandlers>())
  const attachedAgents = useRef(new Set<string>())
  const reconnectAttempt = useRef(0)
  const reconnectTimer = useRef<number | null>(null)
  const aliveRef = useRef(true)
  const lastInboundAt = useRef(Date.now())
  const probeSentAt = useRef<number | null>(null)
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
   * guard an in-flight `pair()` can land after the user has logged out and
   * write the session AND the pairing token straight back into `localStorage`,
   * turning a log-out into a re-authentication.
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

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimer.current === null) return
    window.clearTimeout(reconnectTimer.current)
    reconnectTimer.current = null
  }, [])

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

  /** Reject whatever has outlived its deadline — queued or in flight. */
  const expireCommands = useCallback(() => {
    const expired = expiredCommandIds(pendingCommands.current, Date.now())
    if (expired.length === 0) return
    rejectCommands(expired, remoteCopy(localeRef.current).connectionLost)
  }, [rejectCommands])

  /** Put the queue on the wire, oldest first. Called when `hello` proves it. */
  const flushCommandQueue = useCallback(() => {
    for (const parked of pendingCommands.current.values()) {
      if (parked.frame === null) continue
      const frame = parked.frame
      // Marked sent BEFORE the write: `sendRaw` can only fail by dropping the
      // frame, and a frame recorded as queued but already written would be
      // sent twice on the next flush.
      parked.frame = null
      parked.expiresAt = Date.now() + COMMAND_TIMEOUT_MS
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

  const dispatch = useCallback(
    (message: ServerMessage) => {
      switch (message.type) {
        case 'hello':
          applyWorkspaces(message.workspaces)
          setTheme(message.theme)
          setLocale(message.locale)
          setPhase('ready')
          reconnectAttempt.current = 0
          // Re-attach any terminals the UI was watching before a reconnect.
          for (const agentId of attachedAgents.current) sendRaw({ type: 'attach', agentId })
          // `hello` is the first proof this socket can carry anything, so it is
          // where the taps made while it was down finally go out.
          flushCommandQueue()
          break
        case 'workspaces':
          applyWorkspaces(message.workspaces)
          break
        case 'snapshot':
          terminalHandlers.current
            .get(message.agentId)
            ?.onSnapshot(
              message.snapshot,
              message.cols,
              message.rows,
              message.name,
              message.roleColor
            )
          break
        case 'data':
          terminalHandlers.current.get(message.agentId)?.onData(message.data)
          break
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
            clearAuth()
            setPhase('revoked')
            break
          }
          // Anything else — an expired session, a desktop that restarted and
          // lost its in-memory sessions — is not a decision about this device,
          // so the stored pairing token silently mints a new session.
          clearSession()
          setRepairNonce((nonce) => nonce + 1)
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
    [applyWorkspaces, flushCommandQueue, sendRaw]
  )

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
      // Any frame is proof of life, whichever probe or push produced it.
      lastInboundAt.current = Date.now()
      probeSentAt.current = null
      // Functional form so React bails out instead of re-rendering the whole
      // overview on every terminal `data` frame.
      setProbing((outstanding) => (outstanding ? false : outstanding))
      try {
        dispatch(JSON.parse(event.data as string) as ServerMessage)
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
        if (aliveRef.current && sessionRef.current) connect()
      }, delay)
    }
    socket.onerror = () => socket.close()
  }, [clearReconnectTimer, dispatch, failPendingCommands])

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

  const beginPairing = useCallback(async () => {
    // Captured before the first `await`: a `reset()` or a revoke while the
    // request is in flight bumps the generation, and everything below is then
    // a decision about an auth state that no longer exists.
    const generation = authGeneration.current
    const current = (): boolean => aliveRef.current && authGeneration.current === generation
    const token = tokenFromHash(window.location.hash)
    if (token) {
      // Strip the token from the URL before anything can screenshot it.
      history.replaceState(null, '', window.location.pathname + window.location.search)
      const session = await pair(token)
      if (!current()) return
      if (session) {
        adoptSession(session, token)
        return
      }
      setError('pairingFailed')
      setPhase('error')
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
      const session = await pair(storedPairing)
      if (!current()) return
      if (session) {
        adoptSession(session, storedPairing)
        return
      }
      window.localStorage.removeItem(PAIRING_KEY)
    }
    setPhase('pairing')
  }, [adoptSession, connect])

  useEffect(() => {
    aliveRef.current = true
    void beginPairing()
    return () => {
      aliveRef.current = false
      clearReconnectTimer()
      const socket = socketRef.current
      socketRef.current = null
      socket?.close()
    }
    // Runs once on mount — beginPairing owns the whole connect lifecycle.
  }, [beginPairing, clearReconnectTimer])

  useEffect(() => {
    if (repairNonce === 0) return
    const pairing = readStored(PAIRING_KEY)
    if (!pairing) {
      setPhase('revoked')
      return
    }
    setPhase('connecting')
    const generation = authGeneration.current
    void pair(pairing).then((session) => {
      // Same guard as `beginPairing`: `aliveRef` alone only covers unmount, not
      // a log-out that happened while this request was in flight.
      if (!aliveRef.current || authGeneration.current !== generation) return
      if (session) {
        adoptSession(session, pairing)
        return
      }
      clearAuth()
      setPhase('revoked')
    })
  }, [repairNonce, adoptSession])

  /**
   * Find out where the connection stands, right now, instead of sitting out
   * the rest of a ten-second backoff. Shared by every wake-up (tab visible,
   * network back, bfcache restore) and by the user's own refresh, because they
   * are the same question asked by different means.
   */
  const wake = useCallback(() => {
    if (!aliveRef.current || !sessionRef.current) return
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
  }, [probe, reconnectNow])

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
      sendRaw({ type: 'attach', agentId })
      return () => {
        terminalHandlers.current.delete(agentId)
        attachedAgents.current.delete(agentId)
        sendRaw({ type: 'detach', agentId })
      }
    },
    [sendRaw]
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
    resize: (agentId, cols: number, rows: number) => sendRaw({ type: 'resize', agentId, cols, rows }),
    runCommand: (name, arg, args) => {
      const copy = remoteCopy(localeRef.current)
      if (!commandArgsWithinLimits(args)) {
        // The gateway drops a frame its schema rejects WITHOUT answering it, so
        // sending this would park a promise nothing can ever settle. Refusing
        // here is the only way the caller learns anything at all.
        return Promise.reject(new Error(copy.unknownError))
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
    reset: () => {
      // A deliberate log-out: anything that resumes after an `await` from here
      // on is answering a question nobody is asking any more.
      authGeneration.current += 1
      clearAuth()
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
