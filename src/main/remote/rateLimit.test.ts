import { describe, expect, it } from 'vitest'
import { TokenBucketRateLimiter } from './rateLimit'

describe('TokenBucketRateLimiter', () => {
  it('exhausts and refills independently by key', () => {
    let now = 0
    const limiter = new TokenBucketRateLimiter({ capacity: 2, refillTokens: 1, refillIntervalMs: 1_000, now: () => now })
    expect(limiter.consume('a')).toBe(true)
    expect(limiter.consume('a')).toBe(true)
    expect(limiter.consume('a')).toBe(false)
    expect(limiter.consume('b')).toBe(true)
    now = 1_000
    expect(limiter.consume('a')).toBe(true)
  })

  it('never refills a bucket above its capacity, no matter how long it idles', () => {
    let now = 0
    const limiter = new TokenBucketRateLimiter({ capacity: 3, refillTokens: 1, refillIntervalMs: 1_000, now: () => now })
    // Drain, then idle for an hour — refill must be capped at capacity, not unbounded.
    expect(limiter.consume('k', 3)).toBe(true)
    now = 3_600_000
    expect(limiter.consume('k', 3)).toBe(true)
    // Only 3 tokens available despite the long idle; a 4th token is not granted.
    expect(limiter.consume('k')).toBe(false)
  })

  it('rejects a request larger than the current balance without consuming', () => {
    const now = 0
    const limiter = new TokenBucketRateLimiter({ capacity: 5, refillTokens: 1, refillIntervalMs: 1_000, now: () => now })
    expect(limiter.consume('k', 6)).toBe(false) // amount > capacity: never satisfiable
    expect(limiter.consume('k', 5)).toBe(true) // balance untouched by the rejected request
    expect(limiter.consume('k')).toBe(false)
  })

  it('accumulates fractional refill across sub-interval calls', () => {
    let now = 0
    const limiter = new TokenBucketRateLimiter({ capacity: 2, refillTokens: 2, refillIntervalMs: 1_000, now: () => now })
    expect(limiter.consume('k', 2)).toBe(true)
    now = 250 // 0.5 tokens refilled — not yet enough for a whole token
    expect(limiter.consume('k')).toBe(false)
    now = 500 // total 1.0 token refilled
    expect(limiter.consume('k')).toBe(true)
  })

  it('clear() resets a single key or all keys', () => {
    const limiter = new TokenBucketRateLimiter({ capacity: 1, refillTokens: 1, refillIntervalMs: 1_000 })
    expect(limiter.consume('a')).toBe(true)
    expect(limiter.consume('b')).toBe(true)
    limiter.clear('a')
    expect(limiter.consume('a')).toBe(true) // reset to full capacity
    expect(limiter.consume('b')).toBe(false) // untouched
    limiter.clear()
    expect(limiter.consume('b')).toBe(true) // all reset
  })

  it('rejects invalid configuration', () => {
    expect(() => new TokenBucketRateLimiter({ capacity: 0, refillTokens: 1, refillIntervalMs: 1 })).toThrow(/Ungültige/)
    expect(() => new TokenBucketRateLimiter({ capacity: 1, refillTokens: 0, refillIntervalMs: 1 })).toThrow(/Ungültige/)
    expect(() => new TokenBucketRateLimiter({ capacity: 1, refillTokens: 1, refillIntervalMs: 0 })).toThrow(/Ungültige/)
  })
})

