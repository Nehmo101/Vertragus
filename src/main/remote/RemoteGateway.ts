import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, normalize, resolve } from 'node:path'
import { z } from 'zod'
import type { DeviceInfo, RemoteCommandEnvelope, RemoteEventFrame } from '@shared/remote'
import { RemoteAuditLog } from './auditLog'
import { RemoteCommandError, RemoteCommandRouter } from './commands'
import { DeviceAuth } from './deviceAuth'
import type { RemoteGatewayHandle } from './gatewayHandle'
import { RemoteReadModel } from './readModel'
import { TokenBucketRateLimiter } from './rateLimit'
import type { PushService } from './pushService'
import {
  INBOX_SPEECH_MAX_BYTES,
  INBOX_SPEECH_MAX_DURATION_MS,
  type TranscribeAudioResult
} from '@shared/inboxSpeech'

export const REMOTE_COMMAND_BODY_CAP = 64 * 1024
export const REMOTE_PAIR_BODY_CAP = 8 * 1024
export const REMOTE_PUSH_BODY_CAP = 16 * 1024
export const REMOTE_SPEECH_BODY_CAP = Math.ceil(INBOX_SPEECH_MAX_BYTES * 1.4) + 4 * 1024

interface GatewayOptions {
  auth: DeviceAuth
  audit: RemoteAuditLog
  commands: RemoteCommandRouter
  readModel: RemoteReadModel
  staticDir?: string
  allowedHosts?: string[]
  pushService?: PushService
  transcribeSpeech?(payload: {
    mimeType: string
    bytes: Uint8Array
    durationMs: number
  }): Promise<TranscribeAudioResult>
}

interface AuthenticatedRequest {
  device: DeviceInfo
  token: string
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

const pairSchema = z.object({
  code: z.string().min(1).max(256),
  deviceName: z.string().trim().min(1).max(80)
}).strict()
const pushSubscriptionSchema = z.object({
  endpoint: z.string().url().max(2_048).refine((value) => value.startsWith('https://')),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({
    p256dh: z.string().min(1).max(512),
    auth: z.string().min(1).max(256)
  }).strict()
}).strict()
const speechSchema = z.object({
  mimeType: z.string().min(1).max(100),
  durationMs: z.number().nonnegative().max(INBOX_SPEECH_MAX_DURATION_MS),
  audioBase64: z.string().min(1).max(Math.ceil(INBOX_SPEECH_MAX_BYTES * 4 / 3) + 8)
    .refine((value) => value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value))
}).strict()

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
}

function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  }).end(body)
}

async function readJson(req: IncomingMessage, cap: number): Promise<unknown> {
  const declared = Number(req.headers['content-length'] ?? 0)
  if (Number.isFinite(declared) && declared > cap) throw new HttpError(413, 'Request body too large.')
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += value.length
    if (total > cap) throw new HttpError(413, 'Request body too large.')
    chunks.push(value)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'Malformed JSON.')
  }
}

function bearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization
  if (!header || Array.isArray(header)) return undefined
  const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(header)
  return match?.[1]
}

function requestHost(req: IncomingMessage): string | undefined {
  const raw = req.headers.host
  if (!raw || Array.isArray(raw) || raw.includes('@')) return undefined
  try {
    return new URL(`http://${raw}`).hostname.toLowerCase()
  } catch {
    return undefined
  }
}

function sseFrame(frame: RemoteEventFrame): string {
  return `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`
}

export async function startRemoteGateway(options: GatewayOptions): Promise<RemoteGatewayHandle> {
  const allowedHosts = new Set(['127.0.0.1', 'localhost', ...(options.allowedHosts ?? [])].map((host) => host.toLowerCase()))
  const commandLimiter = new TokenBucketRateLimiter({ capacity: 30, refillTokens: 30, refillIntervalMs: 60_000 })
  const pairLimiter = new TokenBucketRateLimiter({ capacity: 5, refillTokens: 5, refillIntervalMs: 5 * 60_000 })
  const streams = new Map<string, Set<ServerResponse>>()
  let unsubscribe = (): void => undefined

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((error) => {
      const status = error instanceof HttpError || error instanceof RemoteCommandError ? error.status : 500
      if (!res.headersSent) json(res, status, { error: status === 500 ? 'Internal error.' : error.message })
      else res.destroy()
    })
  })

  function hostAllowed(req: IncomingMessage): boolean {
    const host = requestHost(req)
    return Boolean(host && allowedHosts.has(host))
  }

  function authenticate(req: IncomingMessage, action: string): AuthenticatedRequest | undefined {
    const token = bearer(req)
    const device = token ? options.auth.authenticate(token) : undefined
    options.audit.record({
      kind: 'auth',
      outcome: device ? 'accepted' : 'rejected',
      deviceId: device?.id,
      action
    })
    return token && device ? { token, device } : undefined
  }

  function addStream(deviceId: string, res: ServerResponse): void {
    const bucket = streams.get(deviceId) ?? new Set<ServerResponse>()
    bucket.add(res)
    streams.set(deviceId, bucket)
    res.on('close', () => {
      bucket.delete(res)
      if (bucket.size === 0) streams.delete(deviceId)
    })
  }

  function dropDevice(deviceId: string): void {
    for (const res of streams.get(deviceId) ?? []) res.destroy()
    streams.delete(deviceId)
  }

  async function serveStatic(pathname: string, res: ServerResponse): Promise<boolean> {
    if (!options.staticDir) return false
    const root = resolve(options.staticDir)
    const requestPath = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '')
    const candidate = resolve(root, normalize(requestPath))
    const fallback = resolve(root, 'index.html')
    const path = candidate.startsWith(`${root}${process.platform === 'win32' ? '\\' : '/'}`) && existsSync(candidate) && statSync(candidate).isFile()
      ? candidate
      : fallback
    if (!path.startsWith(root) || !existsSync(path)) return false
    res.writeHead(200, {
      'Content-Type': MIME[extname(path)] ?? 'application/octet-stream',
      'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(), microphone=(self), geolocation=()',
      'Cache-Control': path.endsWith('index.html') ? 'no-store' : 'public, max-age=3600'
    })
    createReadStream(path).pipe(res)
    return true
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!hostAllowed(req)) {
      json(res, 421, { error: 'Host is not allowed.' })
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/health' && req.method === 'GET') {
      json(res, 200, { ok: true })
      return
    }
    if (url.pathname === '/pair' && req.method === 'POST') {
      const remoteKey = req.socket.remoteAddress ?? 'unknown'
      if (!pairLimiter.consume(remoteKey)) throw new HttpError(429, 'Too many pairing attempts.')
      const parsed = pairSchema.safeParse(await readJson(req, REMOTE_PAIR_BODY_CAP))
      if (!parsed.success) throw new HttpError(400, 'Invalid pairing request.')
      const result = options.auth.pair(parsed.data.code, parsed.data.deviceName)
      options.audit.record({ kind: 'pair', outcome: result ? 'accepted' : 'rejected', deviceId: result?.device.id })
      if (!result) {
        json(res, 401, { error: 'Invalid or expired pairing code.' })
        return
      }
      json(res, 200, result)
      return
    }
    if (url.pathname === '/stream' && req.method === 'GET') {
      const authenticated = authenticate(req, 'stream')
      if (!authenticated || !authenticated.device.capabilities.includes('read')) {
        json(res, authenticated ? 403 : 401, { error: 'Unauthorized.' })
        return
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'X-Content-Type-Options': 'nosniff'
      })
      addStream(authenticated.device.id, res)
      for (const frame of options.readModel.initialFrames()) res.write(sseFrame(frame))
      options.audit.record({ kind: 'data-access', outcome: 'accepted', deviceId: authenticated.device.id, action: 'stream' })
      return
    }
    if (url.pathname === '/devices' && req.method === 'GET') {
      const authenticated = authenticate(req, 'devices.list')
      if (!authenticated || !authenticated.device.capabilities.includes('read')) {
        json(res, authenticated ? 403 : 401, { error: 'Unauthorized.' })
        return
      }
      options.audit.record({ kind: 'data-access', outcome: 'accepted', deviceId: authenticated.device.id, action: 'devices.list' })
      json(res, 200, { devices: options.auth.listDevices() })
      return
    }
    if (url.pathname === '/push/vapid-key' && req.method === 'GET') {
      const authenticated = authenticate(req, 'push.vapid-key')
      if (!authenticated || !authenticated.device.capabilities.includes('push')) {
        json(res, authenticated ? 403 : 401, { error: 'Unauthorized.' })
        return
      }
      if (!options.pushService) throw new HttpError(404, 'Push service unavailable.')
      const publicKey = await options.pushService.publicKey()
      options.audit.record({
        kind: 'data-access', outcome: 'accepted', deviceId: authenticated.device.id,
        action: 'push.vapid-key'
      })
      json(res, 200, { publicKey })
      return
    }
    if (url.pathname === '/push/subscribe' && req.method === 'POST') {
      const authenticated = authenticate(req, 'push.subscribe')
      if (!authenticated || !authenticated.device.capabilities.includes('push')) {
        json(res, authenticated ? 403 : 401, { error: 'Unauthorized.' })
        return
      }
      if (!options.pushService) throw new HttpError(404, 'Push service unavailable.')
      const parsed = pushSubscriptionSchema.safeParse(await readJson(req, REMOTE_PUSH_BODY_CAP))
      if (!parsed.success) throw new HttpError(400, 'Invalid push subscription.')
      options.pushService.subscribe(authenticated.device.id, parsed.data)
      options.audit.record({
        kind: 'command', outcome: 'accepted', deviceId: authenticated.device.id,
        action: 'push.subscribe'
      })
      json(res, 200, { ok: true })
      return
    }
    if (url.pathname === '/speech/transcribe' && req.method === 'POST') {
      const authenticated = authenticate(req, 'speech.transcribe')
      if (!authenticated || !authenticated.device.capabilities.includes('speech')) {
        json(res, authenticated ? 403 : 401, { error: 'Unauthorized.' })
        return
      }
      if (!options.transcribeSpeech) throw new HttpError(404, 'Speech service unavailable.')
      if (!commandLimiter.consume(authenticated.device.id)) throw new HttpError(429, 'Too many commands.')
      const parsed = speechSchema.safeParse(await readJson(req, REMOTE_SPEECH_BODY_CAP))
      if (!parsed.success) throw new HttpError(400, 'Invalid speech request.')
      const bytes = Buffer.from(parsed.data.audioBase64, 'base64')
      if (bytes.byteLength > INBOX_SPEECH_MAX_BYTES) throw new HttpError(413, 'Audio payload too large.')
      const result = await options.transcribeSpeech({
        mimeType: parsed.data.mimeType,
        durationMs: parsed.data.durationMs,
        bytes
      })
      options.audit.record({
        kind: 'command', outcome: result.ok ? 'accepted' : 'error',
        deviceId: authenticated.device.id, action: 'speech.transcribe',
        detail: result.ok ? { transcriptLength: result.text.length } : { code: result.code }
      })
      json(res, 200, result)
      return
    }
    if (url.pathname === '/command' && req.method === 'POST') {
      const authenticated = authenticate(req, 'command')
      if (!authenticated) {
        json(res, 401, { error: 'Unauthorized.' })
        return
      }
      if (!commandLimiter.consume(authenticated.device.id)) throw new HttpError(429, 'Too many commands.')
      const envelope = await readJson(req, REMOTE_COMMAND_BODY_CAP) as RemoteCommandEnvelope
      try {
        const result = await options.commands.execute(envelope, authenticated.device)
        options.audit.record({
          kind: 'command', outcome: 'accepted', deviceId: authenticated.device.id,
          action: String(envelope?.id ?? ''), requestId: envelope?.requestId,
          detail: { args: envelope?.args }
        })
        json(res, 200, { ok: true, result })
      } catch (error) {
        options.audit.record({
          kind: 'command', outcome: error instanceof RemoteCommandError ? 'rejected' : 'error',
          deviceId: authenticated.device.id, action: String(envelope?.id ?? ''),
          requestId: envelope?.requestId,
          detail: { message: error instanceof Error ? error.message : String(error), args: envelope?.args }
        })
        throw error
      }
      return
    }
    if (req.method === 'GET' && await serveStatic(url.pathname, res)) return
    json(res, 404, { error: 'Not found.' })
  }

  unsubscribe = options.readModel.subscribe((frame) => {
    const encoded = sseFrame(frame)
    for (const responses of streams.values()) {
      for (const res of responses) res.write(encoded)
    }
  })
  const pingTimer = setInterval(() => {
    const encoded = sseFrame({ type: 'ping', at: Date.now() })
    for (const responses of streams.values()) for (const res of responses) res.write(encoded)
  }, 25_000)
  pingTimer.unref()

  options.auth.on('revoked', dropDevice)
  options.auth.on('revoke-all', () => {
    for (const id of [...streams.keys()]) dropDevice(id)
  })

  const port = await new Promise<number>((resolvePort, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      const address = server.address()
      resolvePort(typeof address === 'object' && address ? address.port : 0)
    })
  })

  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    addAllowedHost: (hostname) => allowedHosts.add(hostname.trim().toLowerCase()),
    dropDevice,
    close: () => new Promise<void>((resolveClose) => {
      unsubscribe()
      clearInterval(pingTimer)
      for (const id of [...streams.keys()]) dropDevice(id)
      server.close(() => resolveClose())
      server.closeAllConnections?.()
    })
  }
}

export const remoteGatewayInternals = {
  bearer, requestHost, readJson, sseFrame, pairSchema, pushSubscriptionSchema, speechSchema
}
