import { describe, expect, it } from 'vitest'
import {
  decideLiveness,
  decideWake,
  isSamePayload,
  LIVENESS_PROBE_TIMEOUT_MS,
  LIVENESS_SILENCE_MS,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  reconnectDelayMs,
  tokenFromHash,
  type LivenessState
} from './connection'

describe('reconnectDelayMs', () => {
  it('doubles from the base delay', () => {
    expect(reconnectDelayMs(0)).toBe(RECONNECT_BASE_MS)
    expect(reconnectDelayMs(1)).toBe(RECONNECT_BASE_MS * 2)
    expect(reconnectDelayMs(2)).toBe(RECONNECT_BASE_MS * 4)
  })

  it('caps at the ceiling and never overflows', () => {
    expect(reconnectDelayMs(20)).toBe(RECONNECT_MAX_MS)
    expect(reconnectDelayMs(5000)).toBe(RECONNECT_MAX_MS)
  })

  it('treats a negative or fractional attempt as the first one', () => {
    expect(reconnectDelayMs(-3)).toBe(RECONNECT_BASE_MS)
    expect(reconnectDelayMs(0.9)).toBe(RECONNECT_BASE_MS)
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
