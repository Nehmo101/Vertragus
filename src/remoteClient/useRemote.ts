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
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  RemoteCommand,
  RemoteWorkspaceSummary,
  ServerMessage
} from '@shared/remote/protocol'
import {
  decideLiveness,
  decideWake,
  LIVENESS_TICK_MS,
  reconnectDelayMs,
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
  attach(agentId: string, handlers: TerminalHandlers): () => void
  sendInput(agentId: string, data: string): void
  resize(agentId: string, cols: number, rows: number): void
  /**
   * Run one allow-listed gateway command. Resolves with the command's result
   * and rejects with the gateway's error text — the start form and the answer
   * field need that feedback; fire-and-forget callers may ignore the promise.
   */
  runCommand(name: RemoteCommand, arg?: string, args?: Record<string, string>): Promise<unknown>
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

export function useRemote(): RemoteApi {
  const [phase, setPhase] = useState<RemotePhase>('connecting')
  const [error, setError] = useState<RemoteError | null>(null)
  const [workspaces, setWorkspaces] = useState<RemoteWorkspaceSummary[]>([])
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  const [locale, setLocale] = useState('de')
  const [online, setOnline] = useState(() => window.navigator.onLine)
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
  /** Command promises parked until their command_result frame arrives. */
  const pendingCommands = useRef(
    new Map<string, { resolve: (result: unknown) => void; reject: (error: Error) => void }>()
  )
  const commandSeq = useRef(0)

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
    sendRaw({ type: 'refresh' })
  }, [sendRaw])

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimer.current === null) return
    window.clearTimeout(reconnectTimer.current)
    reconnectTimer.current = null
  }, [])

  /** A socket that goes away takes every command parked on it with it. */
  const failPendingCommands = useCallback(() => {
    if (pendingCommands.current.size === 0) return
    const message = remoteCopy(localeRef.current).connectionLost
    const parked = [...pendingCommands.current.values()]
    pendingCommands.current.clear()
    for (const pending of parked) pending.reject(new Error(message))
  }, [])

  const dispatch = useCallback(
    (message: ServerMessage) => {
      switch (message.type) {
        case 'hello':
          setWorkspaces(message.workspaces)
          setTheme(message.theme)
          setLocale(message.locale)
          setPhase('ready')
          reconnectAttempt.current = 0
          // Re-attach any terminals the UI was watching before a reconnect.
          for (const agentId of attachedAgents.current) sendRaw({ type: 'attach', agentId })
          break
        case 'workspaces':
          setWorkspaces(message.workspaces)
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
          clearSession()
          sessionRef.current = null
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
    [sendRaw]
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

    socket.onopen = () => socket.send(JSON.stringify({ type: 'auth', session }))
    socket.onmessage = (event) => {
      // Any frame is proof of life, whichever probe or push produced it.
      lastInboundAt.current = Date.now()
      probeSentAt.current = null
      try {
        dispatch(JSON.parse(event.data as string) as ServerMessage)
      } catch {
        // A malformed frame from our own server is not worth crashing the UI.
      }
    }
    socket.onclose = () => {
      if (socketRef.current !== socket) return
      socketRef.current = null
      failPendingCommands()
      if (!aliveRef.current || sessionRef.current === null) return
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
    const token = tokenFromHash(window.location.hash)
    if (token) {
      // Strip the token from the URL before anything can screenshot it.
      history.replaceState(null, '', window.location.pathname + window.location.search)
      const session = await pair(token)
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
    void pair(pairing).then((session) => {
      if (!aliveRef.current) return
      if (session) {
        adoptSession(session, pairing)
        return
      }
      clearAuth()
      setPhase('revoked')
    })
  }, [repairNonce, adoptSession])

  // Wake-up: the phone came back, so find out where the connection stands
  // instead of sitting out the rest of a ten-second backoff.
  useEffect(() => {
    const wake = (): void => {
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
    }
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') wake()
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
  }, [probe, reconnectNow])

  useEffect(() => {
    const tick = window.setInterval(() => {
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
  }, [probe, reconnectNow])

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
    attach,
    sendInput: (agentId, data) => sendRaw({ type: 'input', agentId, data }),
    resize: (agentId, cols: number, rows: number) => sendRaw({ type: 'resize', agentId, cols, rows }),
    runCommand: (name, arg, args) => {
      const id = `c${(commandSeq.current += 1)}-${Date.now()}`
      const promise = new Promise<unknown>((resolve, reject) => {
        pendingCommands.current.set(id, { resolve, reject })
      })
      sendRaw({ type: 'command', id, name, arg, args })
      return promise
    },
    refresh: () => sendRaw({ type: 'refresh' }),
    reset: () => {
      clearAuth()
      sessionRef.current = null
      clearReconnectTimer()
      const socket = socketRef.current
      socketRef.current = null
      socket?.close()
      failPendingCommands()
      setPhase('pairing')
    }
  }
}
