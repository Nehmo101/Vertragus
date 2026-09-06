/**
 * Remote authentication: pairing-token verification, session lifecycle, and a
 * login rate limiter. Pure logic with an injected clock and id source, so the
 * whole thing tests without a socket or a timer.
 *
 * Pairing bootstraps a persistent, individually revocable device credential.
 * Only its hash is stored on the host; sessions remain ephemeral.
 * Two additional secrets, two lifetimes:
 * - the **pairing token** is the long-lived shared secret (256-bit), shown to
 *   the user as a QR / URL; regenerating it invalidates every session.
 * - a **session token** is minted per successful pairing, kept in memory only,
 *   expires on idle, and can be revoked individually or en masse.
 *
 * Every comparison is constant-time (the `timingSafeEqual` pattern from the
 * MCP server), and every failure is a flat rejection that leaks nothing about
 * which part was wrong — same posture the loopback MCP endpoint already holds.
 */
import type { RemoteDevice, RemoteDeviceStore } from './deviceStore'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** Session idle expiry rotates the ephemeral secret. Device credentials can renew
 * it across restarts until that device is revoked or the pairing token rotates. */
export const SESSION_IDLE_MS = 7 * 24 * 60 * 60 * 1_000

/** Login attempts allowed per window before pairing is throttled. */
export const LOGIN_ATTEMPT_LIMIT = 8
export const LOGIN_WINDOW_MS = 60_000

export interface RemoteSession {
  /** Public handle for the UI's revoke button — safe to show, unlike `token`. */
  id: string
  token: string
  createdAt: number
  lastSeenAt: number
  /** The client's address, for the connected-clients UI. */
  remoteAddress: string
}

/** Constant-time secret compare that never throws on a length mismatch. */
export function secretEquals(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

export interface AuthStoreDeps {
  /** The current pairing token; read fresh so a regeneration takes effect at once. */
  pairingToken: () => string | undefined
  deviceStore?: RemoteDeviceStore
  now?: () => number
  newToken?: () => string
  idleMs?: number
  attemptLimit?: number
  windowMs?: number
}

export type PairResult =
  | { ok: true; session: string }
  | { ok: false; reason: 'rate_limited' | 'invalid' }

export class RemoteAuthStore {
  private readonly devices = new Map<string, RemoteDevice>()
  private readonly sessions = new Map<string, RemoteSession>()
  private readonly attempts = new Map<string, number[]>()
  private readonly now: () => number
  private readonly newToken: () => string
  private readonly idleMs: number
  private readonly attemptLimit: number
  private readonly windowMs: number

  constructor(private readonly deps: AuthStoreDeps) {
    for (const device of deps.deviceStore?.read() ?? []) this.devices.set(device.id, device)
    this.now = deps.now ?? Date.now
    this.newToken = deps.newToken ?? (() => randomBytes(32).toString('base64url'))
    this.idleMs = deps.idleMs ?? SESSION_IDLE_MS
    this.attemptLimit = deps.attemptLimit ?? LOGIN_ATTEMPT_LIMIT
    this.windowMs = deps.windowMs ?? LOGIN_WINDOW_MS
  }

  /**
   * Exchange a pairing token for a session. Rate-limited per client address:
   * the check runs BEFORE the token compare, so a throttled attacker never
   * even learns whether the token was right.
   */
  pair(pairingToken: string, remoteAddress: string): PairResult {
    if (this.isRateLimited(remoteAddress)) return { ok: false, reason: 'rate_limited' }
    this.recordAttempt(remoteAddress)
    const expected = this.deps.pairingToken()
    if (!expected || !secretEquals(pairingToken, expected)) {
      return { ok: false, reason: 'invalid' }
    }
    const token = this.newToken()
    const at = this.now()
    this.sessions.set(token, {
      id: this.newToken(),
      token,
      createdAt: at,
      lastSeenAt: at,
      remoteAddress
    })
    return { ok: true, session: token }
  }

  /** Enroll from a QR secret, or renew using an independently revocable credential. */
  authenticate(token: string, address: string, deviceCredential = false): PairResult & { deviceCredential?: string } {
    if (!deviceCredential) {
      const paired = this.pair(token, address)
      if (!paired.ok) return paired
      const session = this.sessions.get(paired.session)!
      const credential = 'device.' + randomBytes(32).toString('base64url')
      this.devices.set(session.id, {
        id: session.id, credentialHash: this.hash(credential),
        pairingHash: this.hash(this.deps.pairingToken() ?? ''),
        remoteAddress: address, createdAt: session.createdAt, lastSeenAt: session.lastSeenAt
      })
      this.persistDevices()
      return { ...paired, deviceCredential: credential }
    }
    if (this.isRateLimited(address)) return { ok: false, reason: 'rate_limited' }
    this.recordAttempt(address)
    const device = [...this.devices.values()].find((item) =>
      secretEquals(item.credentialHash, this.hash(token)) &&
      secretEquals(item.pairingHash, this.hash(this.deps.pairingToken() ?? '')))
    if (!device) return { ok: false, reason: 'invalid' }
    const session = this.newToken()
    device.lastSeenAt = this.now()
    device.remoteAddress = address
    this.sessions.set(session, { id: device.id, token: session, createdAt: device.createdAt,
      lastSeenAt: device.lastSeenAt, remoteAddress: address })
    this.persistDevices()
    return { ok: true, session, deviceCredential: token }
  }

  pairedDevices(): RemoteDevice[] {
    return [...this.devices.values()].filter((device) =>
      secretEquals(device.pairingHash, this.hash(this.deps.pairingToken() ?? '')))
  }

  private hash(token: string): string { return createHash('sha256').update(token).digest('hex') }
  private persistDevices(): void { this.deps.deviceStore?.write([...this.devices.values()]) }

  /**
   * Validate a session token and refresh its idle timer. Returns the session
   * (touched) or undefined when it is unknown or has gone idle-expired.
   */
  touch(token: string): RemoteSession | undefined {
    this.sweep()
    const session = this.find(token)
    if (!session) return undefined
    session.lastSeenAt = this.now()
    return session
  }

  /**
   * Validate a session token WITHOUT refreshing its idle timer.
   *
   * The remote client probes an open socket on a timer to tell a live route
   * from a dead one; that traffic proves the socket works, not that a human is
   * there. Running it through {@link touch} would mean any tab left open on a
   * phone renews the 7-day idle window forever — the expiry could never elapse
   * at all, which is the opposite of what it is for. So liveness traffic
   * verifies, and only user-initiated traffic touches.
   */
  verify(token: string): RemoteSession | undefined {
    this.sweep()
    return this.find(token)
  }

  /** Every live session — the connected-clients list. */
  list(): RemoteSession[] {
    this.sweep()
    return [...this.sessions.values()]
  }

  /** Revoke one session by its public id (from the connected-clients list). */
  revoke(id: string): boolean {
    let revoked = this.devices.delete(id)
    if (revoked) this.persistDevices()
    for (const [key, session] of this.sessions) {
      if (session.id === id) {
        this.sessions.delete(key)
        revoked = true
      }
    }
    return revoked
  }

  /** Drop every session — server disabled, or the pairing token regenerated. */
  revokeAll(): void {
    this.sessions.clear()
  }

  get sessionCount(): number {
    this.sweep()
    return this.sessions.size
  }

  private find(token: string): RemoteSession | undefined {
    for (const session of this.sessions.values()) {
      if (secretEquals(session.token, token)) return session
    }
    return undefined
  }

  private sweep(): void {
    const cutoff = this.now() - this.idleMs
    for (const [key, session] of this.sessions) {
      if (session.lastSeenAt < cutoff) this.sessions.delete(key)
    }
    // Prune rate-limit entries whose attempts have all aged out, so the map
    // does not grow one key per distinct source address forever.
    const attemptCutoff = this.now() - this.windowMs
    for (const [address, times] of this.attempts) {
      if (times.every((at) => at < attemptCutoff)) this.attempts.delete(address)
    }
  }

  private isRateLimited(address: string): boolean {
    return this.recentAttempts(address).length >= this.attemptLimit
  }

  private recordAttempt(address: string): void {
    const recent = this.recentAttempts(address)
    recent.push(this.now())
    this.attempts.set(address, recent)
  }

  private recentAttempts(address: string): number[] {
    const cutoff = this.now() - this.windowMs
    return (this.attempts.get(address) ?? []).filter((at) => at >= cutoff)
  }
}
