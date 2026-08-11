/**
 * EventQueue — one ring buffer plus waiters per workspace.
 *
 * This is the piece that replaces all polling in the old orchestrator. A reader
 * calls `wait(cursor, ms)`:
 *   - if anything newer than `cursor` is already buffered it resolves *in the
 *     same tick* (no timer involved),
 *   - otherwise it parks a waiter that `push()` resolves immediately when the
 *     next event arrives.
 *
 * There is deliberately no interval, no `setTimeout` retry loop and no tick
 * granularity anywhere in here — the only timer is the caller's own timeout.
 */
import type { AgentEvent, AgentEventPayload } from '@shared/schema/events'

export const DEFAULT_EVENT_CAPACITY = 1000

interface Waiter {
  cursor: number
  resolve: (events: AgentEvent[]) => void
  dispose: () => void
}

export class EventQueue {
  private readonly buffer: AgentEvent[] = []
  private readonly waiters = new Set<Waiter>()
  private nextSeq = 1
  private closed = false

  constructor(
    private readonly capacity: number = DEFAULT_EVENT_CAPACITY,
    private readonly now: () => number = Date.now
  ) {
    if (capacity < 1) throw new Error('EventQueue capacity must be >= 1')
  }

  /** Seq of the newest event; 0 while the queue is empty. */
  get cursor(): number {
    return this.nextSeq - 1
  }

  /** Buffered event count (drops silently once capacity is exceeded). */
  get size(): number {
    return this.buffer.length
  }

  /** Parked readers — exposed so tests can prove nothing leaks. */
  get waiterCount(): number {
    return this.waiters.size
  }

  /** Stamp `seq`/`ts` onto a payload, buffer it, and wake every reader NOW. */
  push(payload: AgentEventPayload): AgentEvent {
    if (this.closed) throw new Error('EventQueue is closed')
    const event = { ...payload, seq: this.nextSeq++, ts: this.now() } as AgentEvent
    this.buffer.push(event)
    if (this.buffer.length > this.capacity) this.buffer.splice(0, this.buffer.length - this.capacity)

    if (this.waiters.size > 0) {
      // Copy first: a resolve handler may register a new waiter synchronously.
      for (const waiter of [...this.waiters]) {
        if (waiter.cursor >= event.seq) continue
        this.waiters.delete(waiter)
        waiter.dispose()
        waiter.resolve(this.since(waiter.cursor))
      }
    }
    return event
  }

  /**
   * Every buffered event newer than `cursor`.
   *
   * A cursor older than the oldest buffered event yields whatever survived the
   * ring — callers detect the gap via the `seq` jump rather than a silent lie.
   */
  since(cursor: number): AgentEvent[] {
    if (cursor <= 0) return [...this.buffer]
    return this.buffer.filter((event) => event.seq > cursor)
  }

  /** All buffered events, oldest first. */
  all(): AgentEvent[] {
    return [...this.buffer]
  }

  /**
   * Resolve with events newer than `cursor`; if there are none, park until one
   * arrives, `timeoutMs` elapses (→ `[]`), the signal aborts (→ `[]`) or the
   * queue closes (→ `[]`).
   */
  wait(cursor: number, timeoutMs: number, signal?: AbortSignal): Promise<AgentEvent[]> {
    const pending = this.since(cursor)
    if (pending.length > 0) return Promise.resolve(pending)
    if (this.closed || timeoutMs <= 0 || signal?.aborted) return Promise.resolve([])

    return new Promise<AgentEvent[]>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(waiter)
        waiter.dispose()
        resolve([])
      }, timeoutMs)
      // Never hold an Electron/Node process open just to wait for an agent.
      if (typeof timer.unref === 'function') timer.unref()

      const onAbort = (): void => {
        this.waiters.delete(waiter)
        waiter.dispose()
        resolve([])
      }

      const waiter: Waiter = {
        cursor,
        resolve,
        dispose: () => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
        }
      }

      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiters.add(waiter)
    })
  }

  /** Release every parked reader and refuse further pushes. */
  close(): void {
    this.closed = true
    for (const waiter of [...this.waiters]) {
      this.waiters.delete(waiter)
      waiter.dispose()
      waiter.resolve([])
    }
  }

  get isClosed(): boolean {
    return this.closed
  }
}
