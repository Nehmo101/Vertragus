/**
 * The remote client's connection layer: pairing, the WebSocket, and the
 * protocol dispatch. One hook, no store library — the same discipline as the
 * desktop panel.
 *
 * Auth: the pairing URL carries the token in the fragment (`#token=…`); this
 * exchanges it for a session over `POST /api/auth`, keeps the session in
 * `sessionStorage`, and clears the fragment so a shared screenshot of the URL
 * bar leaks nothing. The WebSocket authenticates with its first frame, then
 * multiplexes workspace state, terminals and commands. A dropped socket
 * reconnects with backoff and re-attaches losslessly (the server replays
 * scrollback on attach).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  RemoteCommand,
  RemoteWorkspaceSummary,
  ServerMessage
} from '@shared/remote/protocol'

export type RemotePhase = 'pairing' | 'connecting' | 'ready' | 'error' | 'revoked'

const SESSION_KEY = 'vertragus.remote.session'
const RECONNECT_BASE_MS = 500
const RECONNECT_MAX_MS = 10_000

export interface TerminalHandlers {
  onSnapshot(snapshot: string, cols: number, rows: number, name: string, roleColor: string): void
  onData(data: string): void
  onExit(exitCode: number | null): void
}

export interface RemoteApi {
  phase: RemotePhase
  error: string | null
  workspaces: RemoteWorkspaceSummary[]
  theme: 'dark' | 'light'
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

function readTokenFromHash(): string | undefined {
  const hash = window.location.hash.replace(/^#/, '')
  const params = new URLSearchParams(hash)
  return params.get('token') ?? undefined
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
  const [error, setError] = useState<string | null>(null)
  const [workspaces, setWorkspaces] = useState<RemoteWorkspaceSummary[]>([])
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')

  const socketRef = useRef<WebSocket | null>(null)
  const sessionRef = useRef<string | null>(null)
  const terminalHandlers = useRef(new Map<string, TerminalHandlers>())
  const attachedAgents = useRef(new Set<string>())
  const reconnectAttempt = useRef(0)
  const aliveRef = useRef(true)
  /** Command promises parked until their command_result frame arrives. */
  const pendingCommands = useRef(
    new Map<string, { resolve: (result: unknown) => void; reject: (error: Error) => void }>()
  )
  const commandSeq = useRef(0)

  const sendRaw = useCallback((message: object) => {
    const socket = socketRef.current
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
  }, [])

  const dispatch = useCallback((message: ServerMessage) => {
    switch (message.type) {
      case 'hello':
        setWorkspaces(message.workspaces)
        setTheme(message.theme)
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
          ?.onSnapshot(message.snapshot, message.cols, message.rows, message.name, message.roleColor)
        break
      case 'data':
        terminalHandlers.current.get(message.agentId)?.onData(message.data)
        break
      case 'exit':
        terminalHandlers.current.get(message.agentId)?.onExit(message.exitCode)
        break
      case 'session_revoked':
        window.sessionStorage.removeItem(SESSION_KEY)
        sessionRef.current = null
        setPhase('revoked')
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
  }, [sendRaw])

  const connect = useCallback(() => {
    const session = sessionRef.current
    if (!session) return
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws`)
    socketRef.current = socket
    setPhase('connecting')

    socket.onopen = () => socket.send(JSON.stringify({ type: 'auth', session }))
    socket.onmessage = (event) => {
      try {
        dispatch(JSON.parse(event.data as string) as ServerMessage)
      } catch {
        // A malformed frame from our own server is not worth crashing the UI.
      }
    }
    socket.onclose = () => {
      socketRef.current = null
      // Commands in flight died with the socket — a parked form must not hang.
      for (const pending of pendingCommands.current.values()) {
        pending.reject(new Error('Verbindung unterbrochen.'))
      }
      pendingCommands.current.clear()
      if (!aliveRef.current || phaseIsTerminal()) return
      // Reconnect with capped exponential backoff.
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempt.current, RECONNECT_MAX_MS)
      reconnectAttempt.current += 1
      setPhase('connecting')
      window.setTimeout(() => {
        if (aliveRef.current && sessionRef.current) connect()
      }, delay)
    }
    socket.onerror = () => socket.close()

    function phaseIsTerminal(): boolean {
      // A revoked session must not silently reconnect — it needs to re-pair.
      return sessionRef.current === null
    }
  }, [dispatch])

  const beginPairing = useCallback(async () => {
    const token = readTokenFromHash()
    if (token) {
      // Strip the token from the URL before anything can screenshot it.
      history.replaceState(null, '', window.location.pathname + window.location.search)
      const session = await pair(token)
      if (session) {
        window.sessionStorage.setItem(SESSION_KEY, session)
        sessionRef.current = session
        connect()
        return
      }
      setError('Pairing fehlgeschlagen — der Link ist abgelaufen oder ungültig.')
      setPhase('error')
      return
    }
    const stored = window.sessionStorage.getItem(SESSION_KEY)
    if (stored) {
      sessionRef.current = stored
      connect()
      return
    }
    setPhase('pairing')
  }, [connect])

  useEffect(() => {
    aliveRef.current = true
    void beginPairing()
    return () => {
      aliveRef.current = false
      socketRef.current?.close()
    }
    // Runs once on mount — beginPairing owns the whole connect lifecycle.
  }, [beginPairing])

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
    attach,
    sendInput: (agentId, data) => sendRaw({ type: 'input', agentId, data }),
    resize: (agentId, cols, rows) => sendRaw({ type: 'resize', agentId, cols, rows }),
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
      window.sessionStorage.removeItem(SESSION_KEY)
      sessionRef.current = null
      setPhase('pairing')
    }
  }
}
