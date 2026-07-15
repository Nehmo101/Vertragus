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
})

