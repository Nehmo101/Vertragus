import { describe, expect, it } from 'vitest'
import { clientMessageSchema, MAX_RESUME_TAIL_CHARS } from '@shared/remote/protocol'
import {
  commandArgsWithinLimits,
  commandsToEvict,
  COMMAND_QUEUE_LIMIT,
  COMMAND_TIMEOUT_MS,
  decideCommandDispatch,
  decideLiveness,
  decidePairingRecovery,
  decideWake,
  expiredCommandIds,
  isSamePayload,
  LIVENESS_PROBE_TIMEOUT_MS,
  LIVENESS_SILENCE_MS,
  LIVENESS_TICK_MS,
  MAX_COMMAND_ARG_CHARS,
  offersResumeMarker,
  pairingFailureFromStatus,
  RECONNECT_MAX_MS,
  reconnectDelayMs,
  shouldFailParkedCommands,
  shouldScheduleReconnect,
  tokenFromHash,
  type LivenessState,
  type PairingSource
} from './connection'
import { OVERLAP_TAIL_CHARS, trackWritten } from './terminalAttach'

/*
 * These constants are a budget a phone pays in battery and cellular data, so
 * they are pinned to the numbers a human would argue about — not restated
 * through their own symbols, which is how `expect(f(0)).toBe(BASE)` passes
 * unchanged while the client starts probing twenty times a second.
 */
describe('the rate a phone actually pays', () => {
  it('probes an idle visible tab at most twice a minute', () => {
    expect(LIVENESS_SILENCE_MS).toBeGreaterThanOrEqual(20_000)
    // Each probe is answered with a full workspaces payload; see the module.
    expect(60_000 / LIVENESS_SILENCE_MS).toBeLessThanOrEqual(2)
  })

  it('wakes to evaluate the rule seconds apart, not milliseconds', () => {
    expect(LIVENESS_TICK_MS).toBeGreaterThanOrEqual(1_000)
    // A tick this side of the silence window keeps the verdict from arriving a
    // whole window late.
    expect(LIVENESS_TICK_MS).toBeLessThanOrEqual(LIVENESS_SILENCE_MS / 2)
  })

  it('convicts a dead route inside a minute', () => {
    expect(LIVENESS_SILENCE_MS + LIVENESS_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(60_000)
    // ... and gives the answer long enough to cross a slow tailnet.
    expect(LIVENESS_PROBE_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000)
  })

  it('settles a command well after an ordinary reconnect would have finished', () => {
    expect(COMMAND_TIMEOUT_MS).toBeGreaterThan(RECONNECT_MAX_MS)
    expect(COMMAND_TIMEOUT_MS).toBeGreaterThan(LIVENESS_SILENCE_MS + LIVENESS_PROBE_TIMEOUT_MS)
    // But still inside the patience of someone holding a phone.
    expect(COMMAND_TIMEOUT_MS).toBeLessThanOrEqual(60_000)
  })
})

describe('reconnectDelayMs', () => {
  it('retries almost immediately, then doubles', () => {
    // Absolute values: the first retry has to feel instant, because the socket
    // usually comes back on it.
    expect(reconnectDelayMs(0)).toBe(500)
    expect(reconnectDelayMs(1)).toBe(1_000)
    expect(reconnectDelayMs(2)).toBe(2_000)
    expect(reconnectDelayMs(0)).toBeLessThanOrEqual(1_000)
  })

  it('caps at a ceiling a user will sit through, and never overflows', () => {
    expect(reconnectDelayMs(20)).toBe(10_000)
    expect(reconnectDelayMs(5000)).toBe(RECONNECT_MAX_MS)
    expect(RECONNECT_MAX_MS).toBeLessThanOrEqual(15_000)
  })

  it('treats a negative or fractional attempt as the first one', () => {
    expect(reconnectDelayMs(-3)).toBe(500)
    expect(reconnectDelayMs(0.9)).toBe(500)
  })
})

describe('tokenFromHash', () => {
  it('reads the pairing token with or without the leading hash', () => {
    expect(tokenFromHash('#token=abc')).toBe('abc')
    expect(tokenFromHash('token=abc')).toBe('abc')
  })

  it('ignores other fragment parameters', () => {
    expect(tokenFromHash('#foo=1&token=abc&bar=2')).toBe('abc')
  })

  it('returns undefined for an absent or empty token', () => {
    expect(tokenFromHash('')).toBeUndefined()
    expect(tokenFromHash('#')).toBeUndefined()
    expect(tokenFromHash('#other=1')).toBeUndefined()
    expect(tokenFromHash('#token=')).toBeUndefined()
  })
})

function liveness(overrides: Partial<LivenessState> = {}): LivenessState {
  return {
    now: 100_000,
    lastInboundAt: 100_000,
    probeSentAt: null,
    visible: true,
    open: true,
    ...overrides
  }
}

describe('decideLiveness', () => {
  it('waits while frames keep arriving', () => {
    expect(decideLiveness(liveness())).toBe('wait')
    expect(
      decideLiveness(liveness({ lastInboundAt: 100_000 - (LIVENESS_SILENCE_MS - 1) }))
    ).toBe('wait')
  })

  it('probes once the silence window is over', () => {
    expect(decideLiveness(liveness({ lastInboundAt: 100_000 - LIVENESS_SILENCE_MS }))).toBe('probe')
  })

  it('waits out an in-flight probe, then declares the socket dead', () => {
    const silent = { lastInboundAt: 0 }
    expect(
      decideLiveness(
        liveness({ ...silent, probeSentAt: 100_000 - (LIVENESS_PROBE_TIMEOUT_MS - 1) })
      )
    ).toBe('wait')
    expect(
      decideLiveness(liveness({ ...silent, probeSentAt: 100_000 - LIVENESS_PROBE_TIMEOUT_MS }))
    ).toBe('reconnect')
  })

  it('never probes a hidden tab or a socket that is not open', () => {
    const dead = { lastInboundAt: 0, probeSentAt: 0 }
    expect(decideLiveness(liveness({ ...dead, visible: false }))).toBe('wait')
    expect(decideLiveness(liveness({ ...dead, open: false }))).toBe('wait')
  })
})

describe('decideWake', () => {
  it('reconnects when there is no socket or it is closing', () => {
    expect(decideWake(null)).toBe('reconnect')
    expect(decideWake(2)).toBe('reconnect')
    expect(decideWake(3)).toBe('reconnect')
  })

  it('lets an in-flight handshake finish', () => {
    expect(decideWake(0)).toBe('wait')
  })

  it('probes a socket that claims to be open', () => {
    expect(decideWake(1)).toBe('probe')
  })
})

describe('isSamePayload', () => {
  const list = [
    { workspaceId: 'a', agents: [{ id: '1', status: 'running' }] },
    { workspaceId: 'b', agents: [] }
  ]

  it('recognizes the unchanged answer a liveness probe gets back', () => {
    expect(isSamePayload(list, structuredClone(list))).toBe(true)
    expect(isSamePayload([], [])).toBe(true)
  })

  it('sees a change anywhere in the payload, however deep', () => {
    const changed = structuredClone(list)
    changed[0].agents[0].status = 'waiting'
    expect(isSamePayload(list, changed)).toBe(false)
  })

  it('sees an added, removed or reordered entry', () => {
    expect(isSamePayload(list, list.slice(0, 1))).toBe(false)
    expect(isSamePayload(list, [...list].reverse())).toBe(false)
  })
})

describe('command dispatch — what a tap on a reconnecting socket does', () => {
  it('queues rather than rejects while the socket is down', () => {
    // The whole argument for the queue: `connecting` is where a phone lives,
    // and the tap made a second before the socket returns is the common case.
    expect(decideCommandDispatch({ open: false })).toBe('queue')
    expect(decideCommandDispatch({ open: true })).toBe('send')
  })

  it('drops the oldest taps once the queue is over its bound', () => {
    const ids = Array.from({ length: COMMAND_QUEUE_LIMIT + 3 }, (_, i) => `c${i}`)
    expect(commandsToEvict(ids.slice(0, COMMAND_QUEUE_LIMIT))).toEqual([])
    // Oldest first — those are the taps the user has already given up on.
    expect(commandsToEvict(ids)).toEqual(['c0', 'c1', 'c2'])
    expect(commandsToEvict([])).toEqual([])
  })

  it('is bounded at all, at a number a thumb can reach in a tunnel', () => {
    expect(COMMAND_QUEUE_LIMIT).toBeGreaterThanOrEqual(4)
    expect(COMMAND_QUEUE_LIMIT).toBeLessThanOrEqual(32)
  })
})

describe('expiredCommandIds — nothing stays parked forever', () => {
  const parked: [string, { expiresAt: number }][] = [
    ['queued', { expiresAt: 1_000 }],
    ['in-flight', { expiresAt: 2_000 }]
  ]

  it('settles a command on its deadline, not a millisecond later', () => {
    expect(expiredCommandIds(parked, 999)).toEqual([])
    expect(expiredCommandIds(parked, 1_000)).toEqual(['queued'])
    expect(expiredCommandIds(parked, 2_000)).toEqual(['queued', 'in-flight'])
  })

  it('reads a Map directly — the hook parks its commands in one', () => {
    const map = new Map(parked)
    expect(expiredCommandIds(map, 1_500)).toEqual(['queued'])
  })
})

describe('commandArgsWithinLimits — the frame the server would drop unanswered', () => {
  const value = (length: number): Record<string, string> => ({ text: 'x'.repeat(length) })

  it('refuses exactly what the gateway refuses', () => {
    // Pinned against the real schema rather than against its own constant: the
    // server answers nothing at all to a frame that fails `safeParse`, so a
    // client that disagrees with it by one character parks a dead promise.
    const frame = (length: number): unknown => ({
      type: 'command',
      id: 'c1',
      name: 'answer_question',
      args: value(length)
    })
    expect(clientMessageSchema.safeParse(frame(MAX_COMMAND_ARG_CHARS)).success).toBe(true)
    expect(clientMessageSchema.safeParse(frame(MAX_COMMAND_ARG_CHARS + 1)).success).toBe(false)

    expect(commandArgsWithinLimits(value(MAX_COMMAND_ARG_CHARS))).toBe(true)
    expect(commandArgsWithinLimits(value(MAX_COMMAND_ARG_CHARS + 1))).toBe(false)
  })

  it('passes a command with no structured args at all', () => {
    expect(commandArgsWithinLimits(undefined)).toBe(true)
    expect(commandArgsWithinLimits({})).toBe(true)
  })

  it('checks every value, not just the first', () => {
    expect(
      commandArgsWithinLimits({ ok: 'short', huge: 'x'.repeat(MAX_COMMAND_ARG_CHARS + 1) })
    ).toBe(false)
  })
})

/*
 * The orphan argument, in plain Node. `connect()` clears `socketRef` BEFORE
 * closing the socket it is replacing, so the orphan's `onclose` arrives after
 * a replacement is already in place — and everything that handler does has to
 * be wrong for the orphan and right for the current socket.
 */
describe('what a close event is allowed to do', () => {
  const context = (over: Partial<Parameters<typeof shouldScheduleReconnect>[0]> = {}) => ({
    isCurrent: true,
    alive: true,
    hasSession: true,
    ...over
  })

  it('schedules the reconnect only for the socket that is still current', () => {
    expect(shouldScheduleReconnect(context())).toBe(true)
    // The orphan: a replacement is already connecting behind it, and a second
    // reconnect scheduled here is how double-connects start.
    expect(shouldScheduleReconnect(context({ isCurrent: false }))).toBe(false)
  })

  it('does not reconnect an unmounted hook or a logged-out client', () => {
    expect(shouldScheduleReconnect(context({ alive: false }))).toBe(false)
    expect(shouldScheduleReconnect(context({ hasSession: false }))).toBe(false)
  })

  it('lets only the current socket fail the commands parked on it', () => {
    // An orphan's commands were already settled by the `connect()` call that
    // orphaned it; by the time its close lands, whatever is parked belongs to
    // the socket that replaced it.
    expect(shouldFailParkedCommands({ isCurrent: true })).toBe(true)
    expect(shouldFailParkedCommands({ isCurrent: false })).toBe(false)
  })

  it('still fails parked commands when it will not reconnect', () => {
    // A log-out or an unmount must not leave the UI holding a promise: the
    // two decisions are separate on purpose.
    const loggedOut = context({ hasSession: false })
    expect(shouldFailParkedCommands(loggedOut)).toBe(true)
    expect(shouldScheduleReconnect(loggedOut)).toBe(false)
  })
})

/*
 * The resume marker's size is not a free parameter: it is the only thing that
 * makes a trimmed snapshot alignable on arrival. The bridge answers a resumed
 * attach with the stream FROM the marker, so the tail the terminal aligns on
 * has to be contained in the marker the connection offered — otherwise the
 * aligner finds nothing, calls the streams divergent and rebuilds the terminal
 * from a snapshot that no longer carries the history it would need.
 */
describe('the resume marker covers what the terminal aligns on', () => {
  it('offers at least as much as the aligner looks for', () => {
    expect(MAX_RESUME_TAIL_CHARS).toBeGreaterThanOrEqual(OVERLAP_TAIL_CHARS)
  })

  it('keeps the marker a suffix of the same stream the aligner holds', () => {
    // Both tails are taken from one stream with the same function, so the
    // shorter is a suffix of the longer by construction — this pins that the
    // two limits are used the same way round, which is the part a refactor
    // can silently invert.
    const stream = Array.from({ length: 4000 }, (_, i) => `line ${i}\n`).join('')
    const marker = trackWritten('', stream, MAX_RESUME_TAIL_CHARS)
    const aligned = trackWritten('', stream, OVERLAP_TAIL_CHARS)
    expect(marker.length).toBeGreaterThan(aligned.length)
    expect(marker.endsWith(aligned)).toBe(true)
  })

  it('offers the marker only once there is more behind it than it costs', () => {
    // Below the cap the whole scrollback is no larger than the marker, so the
    // upload buys nothing; above it the marker is 16 KB against up to 2 MB.
    expect(offersResumeMarker(undefined)).toBe(false)
    expect(offersResumeMarker('')).toBe(false)
    expect(offersResumeMarker('x'.repeat(MAX_RESUME_TAIL_CHARS - 1))).toBe(false)
    expect(offersResumeMarker('x'.repeat(MAX_RESUME_TAIL_CHARS))).toBe(true)
  })

  it('bounds what an attach may put on the wire', () => {
    const frame = (length: number): unknown => ({
      type: 'attach',
      agentId: 'a1',
      resume: 'x'.repeat(length)
    })
    expect(clientMessageSchema.safeParse(frame(MAX_RESUME_TAIL_CHARS)).success).toBe(true)
    expect(clientMessageSchema.safeParse(frame(MAX_RESUME_TAIL_CHARS + 1)).success).toBe(false)
  })

  it('still accepts an attach that offers nothing', () => {
    // A first attach has no history to resume from, and an older client sends
    // no marker at all; both must reach the bridge unchanged.
    expect(clientMessageSchema.safeParse({ type: 'attach', agentId: 'a1' }).success).toBe(true)
  })
})


/*
 * The whole point of this table is the asymmetry: a desktop that answered may
 * cost the user their credentials, and a route that swallowed the request may
 * not. A phone opening its home-screen bookmark before the tailnet is up
 * produces the second one on a perfectly good pairing, and the client used to
 * treat it as the first.
 */
describe('what a pairing attempt that yielded no session means', () => {
  const sources: PairingSource[] = ['link', 'stored', 'repair']

  it('never gives up on a request that never arrived, whichever door it came in by', () => {
    for (const source of sources) {
      expect(decidePairingRecovery('unreachable', source)).toBe('retry')
    }
  })

  it('sends a spent LINK to the pairing-failed screen', () => {
    // The token was in the URL and is gone from it now; there is nothing to
    // retry and nothing stored to forget.
    expect(decidePairingRecovery('rejected', 'link')).toBe('showPairingFailed')
  })

  it('forgets a STORED token the desktop declined', () => {
    // The bookmark's token outlived the desktop's; the QR code is the way back.
    expect(decidePairingRecovery('rejected', 'stored')).toBe('forgetPairing')
  })

  it('treats a declined REPAIR as the device being unknown', () => {
    // A `session_revoked` followed by a desktop that refuses the stored token
    // is the one case where the revoked screen is the truth.
    expect(decidePairingRecovery('rejected', 'repair')).toBe('revoke')
  })

  it('lets only an answering desktop cost the user a credential', () => {
    // The invariant behind every row above, stated once: nothing reached by
    // the 'unreachable' path may be destructive.
    const destructive = new Set(['showPairingFailed', 'forgetPairing', 'revoke'])
    for (const source of sources) {
      expect(destructive.has(decidePairingRecovery('unreachable', source))).toBe(false)
      expect(destructive.has(decidePairingRecovery('rejected', source))).toBe(true)
    }
  })
})

describe('reading an HTTP status as one kind of failure or the other', () => {
  it('reads the desktop declining this token as an answer', () => {
    // 401 from the auth store, 400 from a malformed body, 403 from the
    // host-rebinding guard — all of them a desktop that made a decision.
    expect(pairingFailureFromStatus(400)).toBe('rejected')
    expect(pairingFailureFromStatus(401)).toBe('rejected')
    expect(pairingFailureFromStatus(403)).toBe('rejected')
    expect(pairingFailureFromStatus(404)).toBe('rejected')
  })

  it('does not read a rate-limited attempt as a bad token', () => {
    // `RemoteAuthStore.pair` throttles per address BEFORE it compares the
    // token, so a 429 is literally not an opinion about the token — and a user
    // who reloads three times in a row must not lose their pairing for it.
    expect(pairingFailureFromStatus(429)).toBe('unreachable')
  })

  it('does not read a broken desktop or a proxy in the way as a bad token', () => {
    expect(pairingFailureFromStatus(408)).toBe('unreachable')
    expect(pairingFailureFromStatus(500)).toBe('unreachable')
    expect(pairingFailureFromStatus(502)).toBe('unreachable')
    expect(pairingFailureFromStatus(503)).toBe('unreachable')
  })
})

describe('the backoff a pairing retry rides on', () => {
  it('is the schedule the socket already uses, bounded the same way', () => {
    // `attemptPairing` calls `reconnectDelayMs`; this pins that the schedule
    // it shares is bounded, since a pairing retry loop has no socket close to
    // stop it.
    expect(reconnectDelayMs(0)).toBeLessThanOrEqual(1_000)
    expect(reconnectDelayMs(50)).toBe(RECONNECT_MAX_MS)
    expect(RECONNECT_MAX_MS).toBeLessThanOrEqual(30_000)
  })
})
