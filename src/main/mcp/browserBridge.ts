/**
 * Loopback WebSocket bridge between the in-app MCP server and the Chromium
 * extension. Workers call `browser_*` tools; those tools wait here for the
 * extension to run the command in a real tab and send the result back.
 *
 * Same HTTP server as MCP, different path (`/browser`). The MCP Host/Origin
 * allow-list is NOT loosened: chrome-extension origins are accepted only on
 * this path, and only with the pairing token.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import {
  BROWSER_COMMANDS,
  BROWSER_PATH,
  browserPairingUrl,
  isBrowserBridgeOrigin,
  type BrowserCommand
} from '@shared/browserExtension'
import { isAllowedHostHeader } from './httpAllow'

const MAX_WS_PAYLOAD_BYTES = 2 * 1024 * 1024
const DEFAULT_CALL_TIMEOUT_MS = 20_000
const MAX_CLIENTS = 4

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export interface BrowserBridgeOptions {
  token?: string
  onToken?: (token: string) => void
  onChange?: () => void
}

export class BrowserBridge {
  private token: string
  private readonly clients = new Set<WebSocket>()
  private readonly pending = new Map<string, PendingCall>()
  private nextId = 1
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD_BYTES })
  private readonly onToken?: (token: string) => void
  private readonly onChange?: () => void
  port = 0

  constructor(options: BrowserBridgeOptions = {}) {
    this.token = options.token && options.token.length >= 16 ? options.token : randomBytes(32).toString('hex')
    this.onToken = options.onToken
    this.onChange = options.onChange
    if (!options.token) this.onToken?.(this.token)
  }

  status(): {
    token: string
    pairingUrl: string
    connected: boolean
    clients: number
    port: number
  } {
    return {
      token: this.token,
      pairingUrl: browserPairingUrl(this.port, this.token),
      connected: this.clients.size > 0,
      clients: this.clients.size,
      port: this.port
    }
  }

  regenerateToken(): string {
    this.token = randomBytes(32).toString('hex')
    this.onToken?.(this.token)
    for (const client of [...this.clients]) client.close()
    this.clients.clear()
    this.failAll(new Error('pairing token rotated'))
    this.onChange?.()
    return this.token
  }

  /**
   * Handle an HTTP upgrade. Returns true when this path consumed the socket
   * (accepted or destroyed); false when the caller should try another handler.
   */
  handleUpgrade(
    req: IncomingMessage,
    socket: import('node:stream').Duplex,
    head: Buffer,
    bindHost: string
  ): boolean {
    let url: URL
    try {
      url = new URL(req.url ?? '/', `http://${bindHost}`)
    } catch {
      return false
    }
    if (url.pathname !== BROWSER_PATH) return false
    const allowed =
      isAllowedHostHeader(req.headers.host, bindHost) &&
      isBrowserBridgeOrigin(req.headers.origin) &&
      tokenEquals(url.searchParams.get('token'), this.token) &&
      this.clients.size < MAX_CLIENTS
    if (!allowed) {
      socket.destroy()
      return true
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws))
    return true
  }

  handleHttp(req: IncomingMessage, res: ServerResponse, url: URL): void {
    if (req.method !== 'GET') {
      res.writeHead(405).end()
      return
    }
    if (!tokenEquals(url.searchParams.get('token'), this.token)) {
      res.writeHead(401).end()
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, ...this.status() }))
  }

  async call(
    command: string,
    params: Record<string, unknown> = {},
    timeoutMs = DEFAULT_CALL_TIMEOUT_MS
  ): Promise<unknown> {
    if (!BROWSER_COMMANDS.includes(command as BrowserCommand)) {
      throw new Error(`unknown browser command: ${command}`)
    }
    const client = [...this.clients][0]
    if (!client || client.readyState !== WebSocket.OPEN) {
      const error = new Error('browser_disconnected')
      error.name = 'browser_disconnected'
      throw error
    }
    const id = String(this.nextId++)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('browser_timeout'))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, { resolve, reject, timer })
      try {
        client.send(JSON.stringify({ id, type: 'command', command, params }))
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  close(): void {
    this.failAll(new Error('browser bridge closed'))
    for (const client of [...this.clients]) client.close()
    this.clients.clear()
    this.wss.close()
  }

  private accept(ws: WebSocket): void {
    this.clients.add(ws)
    this.onChange?.()
    ws.on('message', (raw) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(String(raw))
      } catch {
        return
      }
      if (!parsed || typeof parsed !== 'object') return
      const message = parsed as {
        id?: unknown
        type?: unknown
        ok?: unknown
        result?: unknown
        error?: unknown
      }
      if (message.type === 'hello') return
      if (message.type !== 'result' || typeof message.id !== 'string') return
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.ok === false) {
        pending.reject(new Error(typeof message.error === 'string' ? message.error : 'browser_error'))
        return
      }
      pending.resolve(message.result)
    })
    ws.on('close', () => {
      this.clients.delete(ws)
      if (this.clients.size === 0) this.failAll(new Error('browser_disconnected'))
      this.onChange?.()
    })
    ws.on('error', () => ws.close())
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(id)
    }
  }
}

function tokenEquals(given: string | null, expected: string): boolean {
  if (!given) return false
  const left = Buffer.from(given, 'utf8')
  const right = Buffer.from(expected, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

export { BROWSER_PATH }
