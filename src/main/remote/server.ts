/**
 * The Vertragus remote server: one opt-in HTTP + WebSocket listener that lets a
 * paired browser on the user's tailnet watch and drive the app.
 *
 * Structure mirrors `mcp/server.ts` (raw `node:http`, the house style) with
 * `ws` handling the upgrade. It serves three things on one port: the built web
 * client (static files), a tiny auth API, and one WebSocket per client that
 * multiplexes terminals and the allow-listed command gateway.
 *
 * Security posture, all enforced here:
 * - Default OFF; this module only runs when the user turns it on in settings.
 * - Every request and every WS upgrade is Host/Origin-validated (a page on a
 *   rebound hostname is a 403 before anything else runs).
 * - `POST /api/auth` is rate-limited and constant-time; a WS authenticates
 *   with its first frame and is closed if the frame is not a valid session.
 * - The command surface is the {@link runRemoteCommand} allow-list, nothing
 *   more — remote control of yolo-mode agents is remote code execution, so the
 *   surface is deliberately tiny.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { WebSocket, WebSocketServer } from 'ws'
import { runRemoteCommand, type RemoteGatewayHost } from './gateway'
import { createTerminalBridge } from './terminalBridge'
import { RemoteAuthStore, type AuthStoreDeps, type RemoteSession } from './auth'
import { indexPath, resolveStaticPath, withWebSocketConnectSrc } from './staticFiles'
import type { TerminalDirectory } from '@main/ipc'
import type { RemoteClientInfo } from '@shared/remote/types'
import { parseClientMessage, type ClientMessage, type ServerMessage } from '@shared/remote/protocol'

const MAX_BODY_BYTES = 64 * 1024
/** Cap a single WebSocket frame — the zod caps run only after ws buffers it. */
const MAX_WS_PAYLOAD_BYTES = 128 * 1024
/** Reject new sockets past this many concurrent connections (pre-auth DoS cap). */
const MAX_CONNECTIONS = 64
/** Drop a slow reader whose outbound buffer grows past this. */
const SOCKET_BUFFER_CEILING_BYTES = 8 * 1024 * 1024
export const REMOTE_DEFAULT_PORT = 9482

/**
 * Which frames count as the client being USED, for the session's idle timer,
 * as opposed to the client checking that the wire still works.
 *
 * An ALLOW-LIST, and deliberately so. The rule this encodes is "only frames a
 * human caused", and an exclusion list gets that backwards: it makes activity
 * the default, so the next liveness-ish verb — a ping, a presence beat, a
 * pull-to-refresh under another name — silently counts as a human and breaks
 * the expiry again without anyone editing this function. A new verb now has to
 * be classified here before it can renew anything.
 *
 * `refresh` is the frame the rule exists for: it is both the overview's reload
 * and the client's liveness probe — the same frame, because a browser cannot
 * send a WebSocket ping and the protocol deliberately has no verb to spare. A
 * phone with the tab open probes every 30 s forever, so touching the session on
 * `refresh` would mean {@link SESSION_IDLE_MS} could never elapse for any
 * client that stayed connected — an idle expiry that expires nothing.
 *
 * The cost of that choice is explicit: a user who does nothing but pull to
 * refresh does not extend their session. Opening the client does (`auth`
 * touches), and so does every attach, input, resize and command.
 *
 * One honest residual: `attach` is on the list because opening a terminal is a
 * human act, but the client also re-attaches every watched agent automatically
 * on every reconnect. A tab left open on a terminal through enough network
 * churn therefore renews the window without a human. Given that the client
 * re-pairs straight through an expiry anyway (see {@link SESSION_IDLE_MS}),
 * that is a smaller hole than it looks, and closing it would need the protocol
 * to say which attaches were asked for.
 */
const USER_ACTIVITY_TYPES = new Set<ClientMessage['type']>([
  'auth',
  'attach',
  'detach',
  'input',
  'resize',
  'command'
])

export function refreshesIdleTimer(type: ClientMessage['type']): boolean {
  return USER_ACTIVITY_TYPES.has(type)
}

/** True for a bare IP literal (v4 or v6) — never a DNS name. */
function isIpLiteral(host: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true
  return host.includes(':') && /^[0-9a-fA-F:.]+$/.test(host)
}

export interface RemoteServerOptions {
  /** Bind address — a Tailscale IP by default; `0.0.0.0` only on explicit opt-in. */
  host: string
  port?: number
  /** Current pairing token; read fresh so a regeneration takes effect at once. */
  pairingToken: () => string | undefined
  /** The command gateway's read/lifecycle host. */
  gateway: RemoteGatewayHost
  /** The live PTY directory, re-read per client so late-started agents appear. */
  terminals: () => TerminalDirectory
  /** Subscribe to workspace changes; the server fans them out to every client. */
  onWorkspaceChange: (listener: () => void) => () => void
  locale: () => string
  theme: () => 'dark' | 'light'
  /** Directory of the built web client (out/remote). */
  staticRoot: string
  /** Auth tuning — tests inject a clock and deterministic tokens. */
  authDeps?: Partial<AuthStoreDeps>
}

export interface RemoteServerHandle {
  port: number
  host: string
  /** Live paired clients, for the settings connected-clients list. */
  clients(): RemoteClientInfo[]
  /** Revoke one session by its token; closes its socket. */
  revoke(token: string): boolean
  close(): Promise<void>
}

/** True when the request's Host/Origin is this server's own address or loopback. */
export function isRequestAllowed(
  headers: { host?: string; origin?: string },
  bindHost: string
): boolean {
  // In 0.0.0.0 mode we bind every interface, so we cannot pin Host to one
  // address — but we can still defeat DNS-rebinding by accepting only bare IP
  // literals (a rebinding attack requires a DNS name it controls). Loopback
  // names stay allowed for a local browser. A tailnet MagicDNS name is
  // therefore rejected in 0.0.0.0 mode; that mode is the by-IP escape hatch.
  const allowAny = bindHost === '0.0.0.0'
  // URL.hostname keeps IPv6 brackets ("[::1]"); normalize so the literal and
  // loopback comparisons see a bare address.
  const bare = (name: string): string => name.replace(/^\[|\]$/g, '')
  const ok = (raw: string): boolean => {
    const name = bare(raw)
    return (
      name === bindHost ||
      name === '127.0.0.1' ||
      name === 'localhost' ||
      name === '::1' ||
      (allowAny && isIpLiteral(name))
    )
  }
  const hostHeader = headers.host
  if (!hostHeader) return false
  let hostName: string
  try {
    hostName = new URL(`http://${hostHeader}`).hostname
  } catch {
    return false
  }
  if (!ok(hostName)) return false
  if (headers.origin !== undefined) {
    let originName: string
    try {
      originName = new URL(headers.origin).hostname
    } catch {
      return false
    }
    if (!ok(originName)) return false
  }
  return true
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    total += buffer.length
    if (total > MAX_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  if (chunks.length === 0) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

export async function startRemoteServer(
  options: RemoteServerOptions
): Promise<RemoteServerHandle> {
  const auth = new RemoteAuthStore({ pairingToken: options.pairingToken, ...options.authDeps })
  /** WS connections that finished the auth handshake. */
  const clients = new Set<Connection>()

  interface Connection {
    socket: WebSocket
    session: RemoteSession
    bridge: ReturnType<typeof createTerminalBridge>
  }

  let socketCount = 0

  const send = (socket: WebSocket, message: ServerMessage): void => {
    if (socket.readyState !== WebSocket.OPEN) return
    // A stalled reader must not grow main-process memory without bound: close
    // it once its outbound buffer runs away.
    if (socket.bufferedAmount > SOCKET_BUFFER_CEILING_BYTES) {
      socket.close()
      return
    }
    socket.send(JSON.stringify(message))
  }

  const httpServer: Server = createServer((req, res) => {
    void handleHttp(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })

  async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isRequestAllowed(req.headers, options.host)) {
      res.writeHead(403).end()
      return
    }
    const url = new URL(req.url ?? '/', `http://${options.host}`)

    if (url.pathname === '/api/auth' && req.method === 'POST') {
      const body = await readBody(req)
      const token = (body as { pairingToken?: unknown } | undefined)?.pairingToken
      if (typeof token !== 'string') {
        res.writeHead(400).end()
        return
      }
      const result = auth.pair(token, req.socket.remoteAddress ?? 'unknown')
      if (!result.ok) {
        res.writeHead(result.reason === 'rate_limited' ? 429 : 401).end()
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({ session: result.session })
      )
      return
    }

    if (req.method !== 'GET') {
      res.writeHead(405).end()
      return
    }

    // Static client. A traversal is a 403; a miss falls back to index.html so
    // the client's hash routing survives a deep link.
    const resolution = resolveStaticPath(options.staticRoot, url.pathname)
    if (resolution.kind === 'forbidden') {
      res.writeHead(403).end()
      return
    }
    // HTML is the one thing served with a substitution in it: the page's CSP
    // names its own WebSocket origin, which only the request knows. See
    // `withWebSocketConnectSrc` — everything else goes out as the bytes on
    // disk.
    const sendHtml = (contentType: string, html: Buffer): void => {
      res
        .writeHead(200, { 'Content-Type': contentType })
        .end(withWebSocketConnectSrc(html.toString('utf8'), req.headers.host))
    }
    try {
      const file = await readFile(resolution.absolutePath)
      if (resolution.contentType.startsWith('text/html')) {
        sendHtml(resolution.contentType, file)
        return
      }
      res.writeHead(200, { 'Content-Type': resolution.contentType }).end(file)
    } catch {
      try {
        const fallback = await readFile(indexPath(options.staticRoot))
        sendHtml('text/html; charset=utf-8', fallback)
      } catch {
        res.writeHead(404).end()
      }
    }
  }

  // maxPayload caps a single frame BEFORE ws buffers it — the zod caps in
  // protocol.ts run only after the full frame is in memory, so without this an
  // unauthenticated peer could push ~100 MB frames (ws's default) to OOM us.
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD_BYTES })

  httpServer.on('upgrade', (req, socket, head) => {
    try {
      const ok =
        isRequestAllowed(req.headers, options.host) &&
        new URL(req.url ?? '/', `http://${options.host}`).pathname === '/ws' &&
        socketCount < MAX_CONNECTIONS
      if (!ok) {
        socket.destroy()
        return
      }
      wss.handleUpgrade(req, socket, head, (ws) => acceptSocket(ws))
    } catch {
      // A throw here (malformed request target) must not reach the process —
      // there is no global uncaughtException handler.
      socket.destroy()
    }
  })

  function acceptSocket(socket: WebSocket): void {
    socketCount += 1
    let connection: Connection | undefined
    // A socket that never authenticates within the grace window is dropped.
    const authTimer = setTimeout(() => {
      if (!connection) socket.close()
    }, 5_000)
    authTimer.unref?.()

    socket.on('message', (raw) => {
      // The whole handler is exception-safe: a synchronous throw from any
      // gateway/bridge call must close the offending socket, never the main
      // process (there is no global uncaughtException handler).
      try {
        const message = parseClientMessage(raw.toString())
        if (!message) return

        if (!connection) {
          if (message.type !== 'auth') {
            socket.close()
            return
          }
          const session = auth.touch(message.session)
          if (!session) {
            // Unknown or idle-expired — not a decision about this device, so
            // the client may silently re-pair from its stored pairing token.
            send(socket, { type: 'session_revoked', reason: 'expired' })
            socket.close()
            return
          }
          clearTimeout(authTimer)
          const bridge = createTerminalBridge({
            terminals: options.terminals(),
            send: (msg) => send(socket, msg)
          })
          connection = { socket, session, bridge }
          clients.add(connection)
          send(socket, {
            type: 'hello',
            workspaces: options.gateway.listWorkspaces(),
            locale: options.locale(),
            theme: options.theme()
          })
          return
        }

        // Every subsequent message revalidates the session; only the ones that
        // are evidence of a user refresh its idle timer (see
        // `refreshesIdleTimer`).
        const live = refreshesIdleTimer(message.type)
          ? auth.touch(connection.session.token)
          : auth.verify(connection.session.token)
        if (!live) {
          send(socket, { type: 'session_revoked', reason: 'expired' })
          socket.close()
          return
        }

        switch (message.type) {
          case 'attach':
            connection.bridge.attach(message.agentId, message.resume)
            break
          case 'detach':
            connection.bridge.detach(message.agentId)
            break
          case 'input':
            connection.bridge.input(message.agentId, message.data)
            break
          case 'resize':
            connection.bridge.resize(message.agentId, message.cols, message.rows)
            break
          case 'refresh':
            send(socket, { type: 'workspaces', workspaces: options.gateway.listWorkspaces() })
            break
          case 'command': {
            void runRemoteCommand(options.gateway, message.name, message.arg, message.args).then(
              (result) => {
                if (result.ok) {
                  send(socket, { type: 'command_result', id: message.id, ok: true, result: result.result })
                } else {
                  send(socket, { type: 'command_result', id: message.id, ok: false, error: result.error })
                }
              },
              () => send(socket, { type: 'command_result', id: message.id, ok: false, error: 'command failed' })
            )
            break
          }
        }
      } catch {
        socket.close()
      }
    })

    socket.on('close', () => {
      clearTimeout(authTimer)
      socketCount = Math.max(0, socketCount - 1)
      if (connection) {
        connection.bridge.dispose()
        clients.delete(connection)
      }
    })
    socket.on('error', () => socket.close())
  }

  // Fan out workspace changes to every connected client.
  const offChange = options.onWorkspaceChange(() => {
    const payload: ServerMessage = { type: 'workspaces', workspaces: options.gateway.listWorkspaces() }
    for (const connection of clients) send(connection.socket, payload)
  })

  const port = await new Promise<number>((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(options.port ?? REMOTE_DEFAULT_PORT, options.host, () => {
      const address = httpServer.address()
      resolve(typeof address === 'object' && address ? address.port : 0)
    })
  })

  return {
    port,
    host: options.host,
    clients: () =>
      auth.list().map((session) => ({
        id: session.id,
        remoteAddress: session.remoteAddress,
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt
      })),
    revoke(id: string): boolean {
      const revoked = auth.revoke(id)
      // Close any live socket whose session just died. `verify`, not `touch`:
      // revoking one client must not renew every other client's idle timer.
      for (const connection of [...clients]) {
        if (auth.verify(connection.session.token)) continue
        // Only the device the user actually revoked is told so; anything else
        // that died here died of old age and may re-pair on its own.
        const reason = revoked && connection.session.id === id ? 'revoked' : 'expired'
        send(connection.socket, { type: 'session_revoked', reason })
        connection.socket.close()
      }
      return revoked
    },
    async close(): Promise<void> {
      offChange()
      auth.revokeAll()
      for (const connection of [...clients]) {
        connection.bridge.dispose()
        connection.socket.close()
      }
      clients.clear()
      wss.close()
      await new Promise<void>((resolve) => httpServer.close(() => resolve()))
    }
  }
}
