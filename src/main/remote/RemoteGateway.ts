import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, normalize, resolve } from 'node:path'
import { z } from 'zod'
import type { DeviceInfo, RemoteCommandEnvelope, RemoteEventFrame } from '@shared/remote'
import { RemoteAuditLog } from './auditLog'
import { RemoteCommandError, RemoteCommandRouter } from './commands'
import { DeviceAuth } from './deviceAuth'
import type { RemoteGatewayHandle } from './gatewayHandle'
import { RemoteReadModel, scopeRemoteFrame } from './readModel'
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
  identityVerifier?: {
    verify(assertion: string | undefined): Promise<import('@shared/remote').RemoteActor | undefined>
  }
  transcribeSpeech?(payload: {
    mimeType: string
    bytes: Uint8Array
    durationMs: number
  }): Promise<TranscribeAudioResult>
}

interface AuthenticatedRequest {
  device: DeviceInfo
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
const apnsSubscriptionSchema = z.object({
  token: z.string().regex(/^[a-fA-F0-9]{64,200}$/),
  environment: z.enum(['sandbox', 'production']),
  bundleId: z.string().regex(/^[A-Za-z0-9.-]{1,200}$/)
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

function websocketBearer(req: IncomingMessage): string | undefined {
  const header = req.headers['sec-websocket-protocol']
  if (!header || Array.isArray(header)) return undefined
  const protocol = header.split(',').map((value) => value.trim())
    .find((value) => value.startsWith('orca-bearer.'))
  const token = protocol?.slice('orca-bearer.'.length)
  return token && /^[A-Za-z0-9_-]{32,512}$/.test(token) ? token : undefined
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
  const streams = new Map<string, Set<{ response: ServerResponse; device: DeviceInfo }>>()
  const sockets = new Map<string, Set<import('ws').WebSocket>>()
  let unsubscribe = (): void => undefined
  const wsRuntime = await import('ws').catch(() => undefined)
  const webSocketServer = wsRuntime ? new wsRuntime.WebSocketServer({
      noServer: true,
      maxPayload: REMOTE_COMMAND_BODY_CAP,
      handleProtocols: (protocols) => protocols.has('orca-v1') ? 'orca-v1' : false
    }) : undefined
  const wsOpen = wsRuntime?.WebSocket.OPEN ?? 1

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

  async function authenticate(
    req: IncomingMessage,
    action: string,
    suppliedToken?: string
  ): Promise<AuthenticatedRequest | undefined> {
    const token = suppliedToken ?? bearer(req)
    let device = token ? options.auth.authenticate(token) : undefined
    let actor = device?.actor
    if (device && options.identityVerifier) {
      const assertion = req.headers['cf-access-jwt-assertion']
      const verified = await options.identityVerifier.verify(
        typeof assertion === 'string' ? assertion : undefined
      )
      if (!verified || verified.id.toLowerCase() !== device.actor.id.toLowerCase()) device = undefined
      else actor = verified
    }
    options.audit.record({
      kind: 'auth',
      outcome: device ? 'accepted' : 'rejected',
      deviceId: device?.id,
      actor: actor?.id,
      action
    })
    return token && device ? { device } : undefined
  }

  function addStream(device: DeviceInfo, res: ServerResponse): void {
    const bucket = streams.get(device.id) ?? new Set<{ response: ServerResponse; device: DeviceInfo }>()
    const entry = { response: res, device }
    bucket.add(entry)
    streams.set(device.id, bucket)
    res.on('close', () => {
      bucket.delete(entry)
      if (bucket.size === 0) streams.delete(device.id)
    })
  }

  function dropDevice(deviceId: string): void {
    for (const entry of streams.get(deviceId) ?? []) entry.response.destroy()
    streams.delete(deviceId)
    for (const socket of sockets.get(deviceId) ?? []) socket.terminate()
    sockets.delete(deviceId)
  }

  function dropAllDevices(): void {
    for (const id of new Set([...streams.keys(), ...sockets.keys()])) dropDevice(id)
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
      const authenticated = await authenticate(req, 'stream')
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
      addStream(authenticated.device, res)
      for (const frame of options.readModel.initialFrames(authenticated.device)) res.write(sseFrame(frame))
      options.audit.record({
        kind: 'data-access', outcome: 'accepted', deviceId: authenticated.device.id,
        actor: authenticated.device.actor.id, action: 'stream'
      })
      return
    }
    if (url.pathname === '/devices' && req.method === 'GET') {
      const authenticated = await authenticate(req, 'devices.list')
      if (!authenticated || !authenticated.device.capabilities.includes('read')) {
        json(res, authenticated ? 403 : 401, { error: 'Unauthorized.' })
        return
      }
      options.audit.record({
        kind: 'data-access', outcome: 'accepted', deviceId: authenticated.device.id,
        actor: authenticated.device.actor.id, action: 'devices.list'
      })
      const devices = options.auth.listDevices().filter((device) =>
        authenticated.device.capabilities.includes('admin') ||
        device.actor.id === authenticated.device.actor.id
      )
      json(res, 200, { devices })
      return
    }
    if (url.pathname === '/push/vapid-key' && req.method === 'GET') {
      const authenticated = await authenticate(req, 'push.vapid-key')
      if (!authenticated || !authenticated.device.capabilities.includes('push')) {
        json(res, authenticated ? 403 : 401, { error: 'Unauthorized.' })
        return
      }
      if (!options.pushService) throw new HttpError(404, 'Push service unavailable.')
      const publicKey = await options.pushService.publicKey()
      options.audit.record({
        kind: 'data-access', outcome: 'accepted', deviceId: authenticated.device.id,
        actor: authenticated.device.actor.id,
        action: 'push.vapid-key'
      })
      json(res, 200, { publicKey })
      return
    }
    if (url.pathname === '/push/subscribe' && req.method === 'POST') {
      const authenticated = await authenticate(req, 'push.subscribe')
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
        actor: authenticated.device.actor.id,
        action: 'push.subscribe'
      })
      json(res, 200, { ok: true })
      return
    }
    if (url.pathname === '/push/apns' && req.method === 'POST') {
      const authenticated = await authenticate(req, 'push.apns-subscribe')
      if (!authenticated || !authenticated.device.capabilities.includes('push')) {
        json(res, authenticated ? 403 : 401, { error: 'Unauthorized.' })
        return
      }
      if (!options.pushService) throw new HttpError(404, 'Push service unavailable.')
      const parsed = apnsSubscriptionSchema.safeParse(await readJson(req, REMOTE_PUSH_BODY_CAP))
      if (!parsed.success) throw new HttpError(400, 'Invalid APNs subscription.')
      options.pushService.subscribeApns(authenticated.device.id, parsed.data)
      // The device token is never written to the audit trail (only the action + device id).
      options.audit.record({
        kind: 'command', outcome: 'accepted', deviceId: authenticated.device.id,
        actor: authenticated.device.actor.id,
        action: 'push.apns-subscribe'
      })
      json(res, 200, { ok: true })
      return
    }
    if (url.pathname === '/speech/transcribe' && req.method === 'POST') {
      const authenticated = await authenticate(req, 'speech.transcribe')
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
        actor: authenticated.device.actor.id,
        detail: result.ok ? { transcriptLength: result.text.length } : { code: result.code }
      })
      json(res, 200, result)
      return
    }
    if (url.pathname === '/command' && req.method === 'POST') {
      const authenticated = await authenticate(req, 'command')
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
          actor: authenticated.device.actor.id,
          action: String(envelope?.id ?? ''), requestId: envelope?.requestId,
          detail: { args: envelope?.args }
        })
        json(res, 200, { ok: true, result })
      } catch (error) {
        options.audit.record({
          kind: 'command', outcome: error instanceof RemoteCommandError ? 'rejected' : 'error',
          deviceId: authenticated.device.id, action: String(envelope?.id ?? ''),
          actor: authenticated.device.actor.id,
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

  server.on('upgrade', (req, socket, head) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const authenticated = hostAllowed(req) && url.pathname === '/ws'
        ? await authenticate(req, 'ws.upgrade', websocketBearer(req))
        : undefined
      if (!authenticated || !authenticated.device.capabilities.includes('read')) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      if (!webSocketServer) {
        socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      webSocketServer.handleUpgrade(req, socket, head, (webSocket) => {
        const device = authenticated.device
        const bucket = sockets.get(device.id) ?? new Set<import('ws').WebSocket>()
        bucket.add(webSocket)
        sockets.set(device.id, bucket)
        webSocket.on('close', () => {
          bucket.delete(webSocket)
          if (bucket.size === 0) sockets.delete(device.id)
        })
        webSocket.on('error', () => undefined)
        for (const frame of options.readModel.initialFrames(device)) {
          webSocket.send(JSON.stringify(frame))
        }
        options.audit.record({
          kind: 'data-access', outcome: 'accepted', deviceId: device.id,
          actor: device.actor.id, action: 'ws.connect'
        })
        webSocket.on('message', (data) => {
          void (async () => {
            let envelope: RemoteCommandEnvelope | undefined
            try {
              if (data.byteLength > REMOTE_COMMAND_BODY_CAP) throw new RemoteCommandError('Request body too large.', 413, 'too_large')
              envelope = JSON.parse(data.toString('utf8')) as RemoteCommandEnvelope
              if (!commandLimiter.consume(device.id)) throw new RemoteCommandError('Too many commands.', 429, 'rate_limited')
              const result = await options.commands.execute(envelope, device)
              options.audit.record({
                kind: 'command', outcome: 'accepted', deviceId: device.id,
                actor: device.actor.id, action: String(envelope.id ?? ''),
                requestId: envelope.requestId, detail: { args: envelope.args, transport: 'ws' }
              })
              if (webSocket.readyState === wsOpen) {
                webSocket.send(JSON.stringify({
                  type: 'command-result', requestId: envelope.requestId, ok: true, result
                }))
              }
            } catch (error) {
              options.audit.record({
                kind: 'command', outcome: error instanceof RemoteCommandError ? 'rejected' : 'error',
                deviceId: device.id, actor: device.actor.id,
                action: String(envelope?.id ?? ''), requestId: envelope?.requestId,
                detail: { message: error instanceof Error ? error.message : String(error), transport: 'ws' }
              })
              if (webSocket.readyState === wsOpen) {
                webSocket.send(JSON.stringify({
                  type: 'command-result', requestId: envelope?.requestId, ok: false,
                  error: error instanceof RemoteCommandError ? error.code : 'internal_error'
                }))
              }
            }
          })()
        })
      })
    })().catch(() => socket.destroy())
  })

  unsubscribe = options.readModel.subscribe((frame) => {
    for (const responses of streams.values()) {
      for (const entry of responses) {
        const scoped = scopeRemoteFrame(frame, entry.device)
        if (scoped) entry.response.write(sseFrame(scoped))
      }
    }
    for (const [deviceId, clients] of sockets) {
      const device = options.auth.listDevices().find((entry) => entry.id === deviceId && !entry.revokedAt)
      if (!device) continue
      const scoped = scopeRemoteFrame(frame, device)
      if (!scoped) continue
      const encoded = JSON.stringify(scoped)
      for (const socket of clients) if (socket.readyState === wsOpen) socket.send(encoded)
    }
  })
  const pingTimer = setInterval(() => {
    const frame: RemoteEventFrame = { type: 'ping', at: Date.now() }
    const encoded = sseFrame(frame)
    for (const responses of streams.values()) {
      for (const entry of responses) entry.response.write(encoded)
    }
    const wsEncoded = JSON.stringify(frame)
    for (const clients of sockets.values()) {
      for (const socket of clients) if (socket.readyState === wsOpen) socket.send(wsEncoded)
    }
  }, 25_000)
  pingTimer.unref()

  options.auth.on('revoked', dropDevice)
  options.auth.on('revoke-all', dropAllDevices)

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
      options.auth.off('revoked', dropDevice)
      options.auth.off('revoke-all', dropAllDevices)
      dropAllDevices()
      webSocketServer?.close()
      server.close(() => resolveClose())
      server.closeAllConnections?.()
    })
  }
}

export const remoteGatewayInternals = {
  bearer, websocketBearer, requestHost, readJson, sseFrame, pairSchema, pushSubscriptionSchema,
  apnsSubscriptionSchema, speechSchema
}
