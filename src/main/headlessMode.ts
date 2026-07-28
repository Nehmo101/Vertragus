import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { brandEnv } from '@main/env'
import type { PairingChallenge, RemoteStatus } from '@shared/remote'

/**
 * Headless host mode (VERTRAGUS_HEADLESS=1): the full engine — MCP server,
 * agent manager, session restore and the Mission-Control gateway — runs
 * without any window, tray, shortcut or updater surface. Control happens
 * exclusively through the remote gateway (roadmap "Detach-Persistenz",
 * step 1: VPS/daemon operation).
 */
export function isHeadlessMode(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = brandEnv('HEADLESS', env)
  return value === '1' || value === 'true'
}

/** Startup log lines for the headless host, warning when it is unreachable. */
export function headlessStartupLines(remoteEnabled: boolean): string[] {
  const lines = [
    '[Headless] Vertragus läuft ohne Fenster; Engine, MCP-Server und Agents sind aktiv.'
  ]
  if (remoteEnabled) {
    lines.push('[Headless] Steuerung über das Mission-Control-Gateway (gepairte Geräte).')
  } else {
    lines.push(
      '[Headless] WARNUNG: Mission Control ist nicht aktiviert — dieser Host ist nicht fernsteuerbar. ' +
        'Remote-Zugriff zuerst in der Desktop-App aktivieren, dann headless starten.'
    )
  }
  return lines
}

/**
 * One structured, machine-parseable stdout line per status change, so
 * `scripts/headless.mjs` (and any supervisor log) can follow the host state:
 * `[headless] gateway=127.0.0.1:PORT tunnel=online url=https://… devices=N`.
 */
export function formatHeadlessStatusLine(status: RemoteStatus): string {
  const gateway =
    status.gatewayRunning && status.gatewayPort ? `127.0.0.1:${status.gatewayPort}` : 'aus'
  const parts = [`[headless] gateway=${gateway}`, `tunnel=${status.tunnel}`]
  if (status.publicUrl) parts.push(`url=${status.publicUrl}`)
  parts.push(`devices=${status.deviceCount}`)
  if (status.error) parts.push(`error=${JSON.stringify(status.error)}`)
  return parts.join(' ')
}

/** Name of the control descriptor the headless host writes into userData. */
export const HEADLESS_CONTROL_FILENAME = 'headless-control.json'

/** The slice of RemoteService the local control server needs. */
export interface HeadlessRemoteControl {
  status(): RemoteStatus
  startPairing(): Promise<PairingChallenge>
}

export interface HeadlessControlOptions {
  /** Electron userData directory; the token file lives next to the device store. */
  userDataDir: string
  remote: HeadlessRemoteControl
  /** Ordered app shutdown (app.quit() — runs the before-quit sequence). */
  quit(): void
  /** Injectable for tests; defaults to 32 random bytes. */
  token?: string
}

export interface HeadlessControlHandle {
  port: number
  filePath: string
  close(): Promise<void>
}

const CONTROL_ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost'])

function controlJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res
    .writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    })
    .end(body)
}

function controlHostAllowed(req: IncomingMessage): boolean {
  const raw = req.headers.host
  if (!raw || Array.isArray(raw) || raw.includes('@')) return false
  try {
    return CONTROL_ALLOWED_HOSTS.has(new URL(`http://${raw}`).hostname.toLowerCase())
  } catch {
    return false
  }
}

function tokenMatches(req: IncomingMessage, expected: string): boolean {
  const header = req.headers.authorization
  if (!header || Array.isArray(header)) return false
  const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(header)
  if (!match) return false
  // Hash both sides so timingSafeEqual sees equal lengths for any input.
  const supplied = createHash('sha256').update(match[1]!, 'utf8').digest()
  const wanted = createHash('sha256').update(expected, 'utf8').digest()
  return timingSafeEqual(supplied, wanted)
}

/**
 * Local admin plane for the headless CLI (`scripts/headless.mjs`): a
 * loopback-only HTTP server on a random port whose bearer token is written —
 * user-readable only — to `userData/headless-control.json`. Whoever can read
 * that file already owns the encrypted device store next to it, so this adds
 * no new trust boundary. The server exposes exactly three operations the
 * desktop UI also offers the local owner: read status, start a pairing
 * (the gateway's public /pair endpoint still requires the one-time code),
 * and an ordered shutdown.
 */
export async function startHeadlessControl(
  options: HeadlessControlOptions
): Promise<HeadlessControlHandle> {
  const token = options.token ?? randomBytes(32).toString('base64url')

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!controlHostAllowed(req)) {
      controlJson(res, 421, { error: 'Host is not allowed.' })
      return
    }
    if (!tokenMatches(req, token)) {
      controlJson(res, 401, { error: 'Unauthorized.' })
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/status' && req.method === 'GET') {
      controlJson(res, 200, options.remote.status())
      return
    }
    if (url.pathname === '/pair' && req.method === 'POST') {
      try {
        const challenge = await options.remote.startPairing()
        // qrDataUrl (PNG data URL) is desktop-UI-only; the CLI renders its own
        // terminal QR from pairingUrl.
        controlJson(res, 200, {
          code: challenge.code,
          expiresAt: challenge.expiresAt,
          pairingUrl: challenge.pairingUrl
        })
      } catch (error) {
        controlJson(res, 409, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }
    if (url.pathname === '/shutdown' && req.method === 'POST') {
      controlJson(res, 202, { ok: true })
      setImmediate(() => options.quit())
      return
    }
    controlJson(res, 404, { error: 'Not found.' })
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) controlJson(res, 500, { error: 'Internal error.' })
      else res.destroy()
    })
  })

  const port = await new Promise<number>((resolvePort, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      const address = server.address()
      resolvePort(typeof address === 'object' && address ? address.port : 0)
    })
  })

  const filePath = join(options.userDataDir, HEADLESS_CONTROL_FILENAME)
  mkdirSync(options.userDataDir, { recursive: true })
  writeFileSync(
    filePath,
    `${JSON.stringify({ pid: process.pid, port, token, createdAt: Date.now() }, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 }
  )

  return {
    port,
    filePath,
    close: () =>
      new Promise<void>((resolveClose) => {
        try {
          rmSync(filePath, { force: true })
        } catch {
          // The stale descriptor is detected via a failing /status probe.
        }
        server.close(() => resolveClose())
        server.closeAllConnections?.()
      })
  }
}
