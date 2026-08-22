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
 *
 * S2 quiet events: `push(payload, { quiet: true })` buffers and taps like any
 * other event but never wakes a parked waiter — the event rides along with
 * whatever ends the wait (a non-quiet push OR the timeout), so it costs no
 * model turn of its own yet is never lost and always advances the cursor.
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
  private readonly listeners = new Set<(event: AgentEvent) => void>()
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

  /**
   * Stamp `seq`/`ts` onto a payload, buffer it, and wake every reader NOW —
   * unless `quiet`, in which case only the `onPush` listeners (journal, panel
   * tap, retro) see it immediately; parked waiters keep sleeping and pick it
   * up with their next wake or timeout.
   */
  push(payload: AgentEventPayload, opts?: { quiet?: boolean }): AgentEvent {
    if (this.closed) throw new Error('EventQueue is closed')
    // Stamp the flag only when true — no `quiet: undefined` keys in journals.
    const event = {
      ...payload,
      seq: this.nextSeq++,
      ts: this.now(),
      ...(opts?.quiet ? { quiet: true as const } : {})
    } as AgentEvent
    this.buffer.push(event)
    if (this.buffer.length > this.capacity) this.buffer.splice(0, this.buffer.length - this.capacity)

    if (!event.quiet && this.waiters.size > 0) {
      // Copy first: a resolve handler may register a new waiter synchronously.
      for (const waiter of [...this.waiters]) {
        if (waiter.cursor >= event.seq) continue
        this.waiters.delete(waiter)
        waiter.dispose()
        waiter.resolve(this.since(waiter.cursor))
      }
    }
    for (const listener of [...this.listeners]) listener(event)
    return event
  }

  /**
   * Observe every pushed event, past the ring's capacity limit — this is how a
   * long run's full history survives for the retro at workspace stop. Returns
   * the unsubscribe function.
   */
  onPush(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
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
   * The seq range a reader at `cursor` can no longer get: events that fell out
   * of the ring before it asked. `undefined` when nothing is missing. `since()`
   * silently yields "whatever survived" — this is the honest companion that
   * lets `await_events` SAY so instead of leaving the orchestrator to infer a
   * gap from a seq jump nothing told it to look for.
   */
  droppedSince(cursor: number): { from: number; to: number } | undefined {
    const oldest = this.buffer[0]?.seq
    // An empty buffer means nothing was ever pushed — overflow never empties it.
    if (oldest === undefined) return undefined
    const from = Math.max(1, cursor + 1)
    if (oldest <= from) return undefined
    return { from, to: oldest - 1 }
  }

  /**
   * Resolve with events newer than `cursor`; park unless at least one of them
   * is NON-quiet (quiet-only backlog is not worth a model turn). Whatever ends
   * the wait — a non-quiet push, `timeoutMs`, an abort or `close()` — resolves
   * with `since(cursor)`, quiet events included: they must never be dropped,
   * or the cursor could never advance past them. All four exits behave the
   * same on purpose — one delivery rule, no path-specific event loss.
   */
  wait(cursor: number, timeoutMs: number, signal?: AbortSignal): Promise<AgentEvent[]> {
    const pending = this.since(cursor)
    if (pending.some((event) => !event.quiet)) return Promise.resolve(pending)
    if (this.closed || timeoutMs <= 0 || signal?.aborted) return Promise.resolve(pending)

    return new Promise<AgentEvent[]>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(waiter)
        waiter.dispose()
        resolve(this.since(cursor))
      }, timeoutMs)
      // Never hold an Electron/Node process open just to wait for an agent.
      if (typeof timer.unref === 'function') timer.unref()

      const onAbort = (): void => {
        this.waiters.delete(waiter)
        waiter.dispose()
        resolve(this.since(cursor))
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

  /**
   * Release every parked reader (handing each its `since(cursor)` backlog —
   * quiet events included, same rule as every other wait exit) and refuse
   * further pushes.
   */
  close(): void {
    this.closed = true
    this.listeners.clear()
    for (const waiter of [...this.waiters]) {
      this.waiters.delete(waiter)
      waiter.dispose()
      waiter.resolve(this.since(waiter.cursor))
    }
  }

  get isClosed(): boolean {
    return this.closed
  }
}
