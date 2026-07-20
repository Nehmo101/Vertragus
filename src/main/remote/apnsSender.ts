/**
 * Dependency-free APNs (Apple Push Notification service) HTTP/2 sender.
 *
 * Uses only Node builtins: `node:crypto` for the ES256 provider JWT and
 * `node:http2` for the token-based `/3/device/<token>` request. The desktop is
 * the APNs sender in the P2P model; signing credentials are a user-configured
 * encrypted desktop secret (never shipped in the binary).
 *
 * The module is deliberately factored for testing without opening a socket:
 * `buildApnsJwt` and `buildApnsRequest` are pure, and `Http2ApnsSender` accepts
 * an injectable {@link ApnsTransport} so `send` can run against a fake.
 */
import { createPrivateKey, sign } from 'node:crypto'
import { connect, constants, type ClientHttp2Session } from 'node:http2'

export type ApnsEnvironment = 'sandbox' | 'production'

/** ES256 signing material for the APNs provider token (never logged). */
export interface ApnsCredential {
  teamId: string
  keyId: string
  /** PEM-encoded `.p8` private key (PKCS#8). */
  p8: string
}

export interface ApnsSendTarget {
  environment: ApnsEnvironment
  bundleId: string
}

export interface ApnsSendResult {
  status: number
  /** Parsed from the APNs JSON error body `{ reason }` when present. */
  reason?: string
}

/** Abstraction mirroring `WebPushModule`, so `PushService` can receive it lazily. */
export interface ApnsSender {
  send(token: string, payload: unknown, target: ApnsSendTarget): Promise<ApnsSendResult>
  close(): void
}

/** Low-level transport, injectable so `send` is unit-testable without a real socket. */
export interface ApnsTransport {
  request(parts: ApnsRequestParts): Promise<ApnsSendResult>
  close(): void
}

export interface ApnsRequestParts {
  /** Full origin passed to `http2.connect` (sets `:authority`/`:scheme`). */
  authority: string
  method: 'POST'
  path: string
  headers: Record<string, string>
  body: string
}

/** Provider JWTs are valid for up to 60 min; regenerate a little early. */
export const APNS_JWT_TTL_MS = 40 * 60 * 1000

export const APNS_HOSTS: Record<ApnsEnvironment, string> = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com'
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

/**
 * Build the ES256 provider JWT:
 * `base64url(header).base64url(claims).base64url(signature)` with
 * `header = { alg: 'ES256', kid }` and `claims = { iss: teamId, iat }`.
 */
export function buildApnsJwt(
  credential: ApnsCredential,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): string {
  const header = { alg: 'ES256', kid: credential.keyId }
  const claims = { iss: credential.teamId, iat: nowSeconds }
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`
  const signature = sign(null, Buffer.from(signingInput), {
    key: createPrivateKey(credential.p8),
    dsaEncoding: 'ieee-p1363'
  })
  return `${signingInput}.${base64url(signature)}`
}

/** Pure builder for the APNs request: host per environment, path, headers, body. */
export function buildApnsRequest(
  token: string,
  payload: unknown,
  target: ApnsSendTarget,
  jwt: string
): ApnsRequestParts {
  return {
    authority: APNS_HOSTS[target.environment],
    method: 'POST',
    path: `/3/device/${token}`,
    headers: {
      authorization: `bearer ${jwt}`,
      'apns-topic': target.bundleId,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'content-type': 'application/json'
    },
    body: JSON.stringify(payload)
  }
}

/** Real HTTP/2 transport with a pooled session per host. */
export class Http2ApnsTransport implements ApnsTransport {
  private readonly sessions = new Map<string, ClientHttp2Session>()

  private session(authority: string): ClientHttp2Session {
    const existing = this.sessions.get(authority)
    if (existing && !existing.closed && !existing.destroyed) return existing
    const session = connect(authority)
    session.setTimeout(60_000, () => session.close())
    const forget = (): void => {
      if (this.sessions.get(authority) === session) this.sessions.delete(authority)
    }
    session.on('error', forget)
    session.on('close', forget)
    this.sessions.set(authority, session)
    return session
  }

  request(parts: ApnsRequestParts): Promise<ApnsSendResult> {
    return new Promise<ApnsSendResult>((resolve, reject) => {
      let session: ClientHttp2Session
      try {
        session = this.session(parts.authority)
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
        return
      }
      const stream = session.request({
        [constants.HTTP2_HEADER_METHOD]: parts.method,
        [constants.HTTP2_HEADER_PATH]: parts.path,
        ...parts.headers
      })
      let status = 0
      const chunks: Buffer[] = []
      stream.on('response', (headers) => {
        status = Number(headers[constants.HTTP2_HEADER_STATUS]) || 0
      })
      stream.on('data', (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      })
      stream.on('error', reject)
      stream.on('end', () => {
        let reason: string | undefined
        if (chunks.length > 0) {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { reason?: unknown }
            if (parsed && typeof parsed.reason === 'string') reason = parsed.reason
          } catch {
            // Non-JSON or empty body: leave reason undefined.
          }
        }
        resolve({ status, reason })
      })
      stream.setTimeout(15_000, () => stream.close(constants.NGHTTP2_CANCEL))
      stream.end(parts.body)
    })
  }

  close(): void {
    for (const session of this.sessions.values()) {
      try { session.close() } catch { /* already closing */ }
    }
    this.sessions.clear()
  }
}

/** APNs sender that caches the provider JWT and reuses one HTTP/2 session per host. */
export class Http2ApnsSender implements ApnsSender {
  private cachedJwt: { value: string; issuedAtMs: number } | undefined

  constructor(
    private readonly credential: ApnsCredential,
    private readonly transport: ApnsTransport = new Http2ApnsTransport(),
    private readonly now: () => number = Date.now
  ) {}

  private jwt(): string {
    const nowMs = this.now()
    if (this.cachedJwt && nowMs - this.cachedJwt.issuedAtMs <= APNS_JWT_TTL_MS) {
      return this.cachedJwt.value
    }
    const value = buildApnsJwt(this.credential, Math.floor(nowMs / 1000))
    this.cachedJwt = { value, issuedAtMs: nowMs }
    return value
  }

  send(token: string, payload: unknown, target: ApnsSendTarget): Promise<ApnsSendResult> {
    return this.transport.request(buildApnsRequest(token, payload, target, this.jwt()))
  }

  close(): void {
    this.transport.close()
  }
}

const APNS_PRUNE_REASONS = new Set(['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic'])

/**
 * Whether an APNs response means the device token is permanently invalid and
 * should be pruned: HTTP 410, or HTTP 400 with a terminal `reason`.
 */
export function isApnsTokenGone(result: ApnsSendResult): boolean {
  if (result.status === 410) return true
  return result.status === 400 && typeof result.reason === 'string' && APNS_PRUNE_REASONS.has(result.reason)
}
