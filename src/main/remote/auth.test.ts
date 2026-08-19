import { describe, expect, it } from 'vitest'
import { RemoteAuthStore, secretEquals } from './auth'

function fixedClock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let value = start
  return { now: () => value, advance: (ms) => (value += ms) }
}

function store(
  pairingToken: string | undefined = 'pair-secret',
  overrides: Partial<ConstructorParameters<typeof RemoteAuthStore>[0]> = {}
): { auth: RemoteAuthStore; clock: ReturnType<typeof fixedClock> } {
  const clock = fixedClock()
  let counter = 0
  const auth = new RemoteAuthStore({
    pairingToken: () => pairingToken,
    now: clock.now,
    newToken: () => `session-${++counter}`,
    ...overrides
  })
  return { auth, clock }
}

describe('secretEquals', () => {
  it('is length-safe and rejects mismatches and blanks', () => {
    expect(secretEquals('abc', 'abc')).toBe(true)
    expect(secretEquals('abc', 'abd')).toBe(false)
    expect(secretEquals('abc', 'abcd')).toBe(false)
    expect(secretEquals(undefined, 'abc')).toBe(false)
    expect(secretEquals('abc', undefined)).toBe(false)
  })
})

describe('RemoteAuthStore.pair', () => {
  it('mints a session for the right token', () => {
    const { auth } = store()
    const result = auth.pair('pair-secret', '100.64.0.2')
    expect(result).toEqual({ ok: true, session: 'session-1' })
    expect(auth.sessionCount).toBe(1)
  })

  it('rejects a wrong token without minting anything', () => {
    const { auth } = store()
    expect(auth.pair('nope', '100.64.0.2')).toEqual({ ok: false, reason: 'invalid' })
    expect(auth.sessionCount).toBe(0)
  })

  it('rejects when no pairing token is set (server just enabled, none generated)', () => {
    const { auth } = store(undefined)
    expect(auth.pair('anything', '100.64.0.2')).toEqual({ ok: false, reason: 'invalid' })
  })

  it('throttles brute force per client address, before the token is even checked', () => {
    const { auth } = store('pair-secret', { attemptLimit: 3, windowMs: 60_000 })
    for (let i = 0; i < 3; i++) auth.pair('wrong', '100.64.0.9')
    // The fourth attempt is rate-limited — even with the correct token.
    expect(auth.pair('pair-secret', '100.64.0.9')).toEqual({ ok: false, reason: 'rate_limited' })
    // A different client is unaffected.
    expect(auth.pair('pair-secret', '100.64.0.10').ok).toBe(true)
  })

  it('lets the limit recover after the window passes', () => {
    const { auth, clock } = store('pair-secret', { attemptLimit: 2, windowMs: 1_000 })
    auth.pair('wrong', 'x')
    auth.pair('wrong', 'x')
    expect(auth.pair('pair-secret', 'x').ok).toBe(false)
    clock.advance(1_001)
    expect(auth.pair('pair-secret', 'x').ok).toBe(true)
  })

  it('prunes stale rate-limit entries so the attempts map does not grow forever', () => {
    const { auth, clock } = store('pair-secret', { attemptLimit: 5, windowMs: 1_000, idleMs: 1 })
    // Many distinct source addresses each make one failed attempt.
    for (let i = 0; i < 50; i++) auth.pair('wrong', `addr-${i}`)
    clock.advance(2_000)
    // A sweep (triggered by list()) drops the aged-out attempt entries; a fresh
    // attempt from an old address is not pre-counted.
    auth.list()
    expect(auth.pair('pair-secret', 'addr-0').ok).toBe(true)
  })
})

describe('RemoteAuthStore session lifecycle', () => {
  it('touches a valid session and expires an idle one', () => {
    const { auth, clock } = store('pair-secret', { idleMs: 1_000 })
    const paired = auth.pair('pair-secret', 'x')
    const token = paired.ok ? paired.session : ''

    clock.advance(900)
    expect(auth.touch(token)).toBeDefined() // refreshes lastSeenAt
    clock.advance(900)
    expect(auth.touch(token)).toBeDefined() // still alive — the touch reset the clock
    clock.advance(1_001)
    expect(auth.touch(token)).toBeUndefined() // now idle-expired
    expect(auth.sessionCount).toBe(0)
  })

  it('revokes one session by its public id and revokes all', () => {
    const { auth } = store()
    auth.pair('pair-secret', 'x')
    const b = auth.pair('pair-secret', 'y')
    const [first] = auth.list()
    // Revoke targets the public id, never the secret token.
    expect(auth.revoke(first!.id)).toBe(true)
    expect(auth.revoke(first!.id)).toBe(false)
    expect(auth.sessionCount).toBe(1)
    auth.revokeAll()
    expect(auth.sessionCount).toBe(0)
    expect(b.ok).toBe(true)
  })

  it('exposes a public id distinct from the session token', () => {
    const { auth } = store()
    const result = auth.pair('pair-secret', 'x')
    const [session] = auth.list()
    expect(session!.id).toBeTruthy()
    expect(session!.id).not.toBe(result.ok ? result.session : '')
  })
})
