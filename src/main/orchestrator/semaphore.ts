/**
 * A tiny async counting semaphore. Used to cap how many subagents of a given
 * role run at once (the slot's `count` = parallel capacity); extra dispatches
 * queue until a slot frees up.
 */
export class Semaphore {
  private active = 0
  private readonly queue: Array<() => void> = []

  constructor(private limit: number) {}

  get inUse(): number {
    return this.active
  }

  get limitValue(): number {
    return this.limit
  }

  setLimit(n: number): void {
    this.limit = Math.max(1, n)
    // A raised limit may let queued waiters through.
    while (this.active < this.limit && this.queue.length > 0) {
      this.active++
      this.queue.shift()!()
    }
  }

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++
      return
    }
    await new Promise<void>((resolve) => this.queue.push(resolve))
  }

  release(): void {
    const next = this.queue.shift()
    if (next) next() // hand the slot straight to the next waiter
    else this.active = Math.max(0, this.active - 1)
  }
}
