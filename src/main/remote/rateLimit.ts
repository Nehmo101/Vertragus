export interface TokenBucketOptions {
  capacity: number
  refillTokens: number
  refillIntervalMs: number
  now?: () => number
}

interface Bucket {
  tokens: number
  updatedAt: number
}

/** In-memory token buckets; a restart never grants more than the configured initial capacity. */
export class TokenBucketRateLimiter {
  private readonly buckets = new Map<string, Bucket>()
  private readonly now: () => number

  constructor(private readonly options: TokenBucketOptions) {
    if (options.capacity <= 0 || options.refillTokens <= 0 || options.refillIntervalMs <= 0) {
      throw new Error('Ungültige Rate-Limit-Konfiguration.')
    }
    this.now = options.now ?? Date.now
  }

  consume(key: string, amount = 1): boolean {
    const at = this.now()
    const bucket = this.buckets.get(key) ?? { tokens: this.options.capacity, updatedAt: at }
    const elapsed = Math.max(0, at - bucket.updatedAt)
    const refill = (elapsed / this.options.refillIntervalMs) * this.options.refillTokens
    bucket.tokens = Math.min(this.options.capacity, bucket.tokens + refill)
    bucket.updatedAt = at
    if (bucket.tokens < amount) {
      this.buckets.set(key, bucket)
      return false
    }
    bucket.tokens -= amount
    this.buckets.set(key, bucket)
    return true
  }

  clear(key?: string): void {
    if (key) this.buckets.delete(key)
    else this.buckets.clear()
  }
}

