import { describe, expect, it, vi } from 'vitest'
import type { AgentEventPayload } from '@shared/schema/events'
import { EventQueue } from './eventQueue'

function progress(note: string, agentId = 'a1'): AgentEventPayload {
  return { type: 'agent_progress', agentId, name: 'Arlecchino', roleId: 'worker', note }
}

describe('EventQueue', () => {
  it('stamps a strictly increasing seq starting at 1', () => {
    const queue = new EventQueue()
    expect(queue.cursor).toBe(0)
    expect(queue.push(progress('a')).seq).toBe(1)
    expect(queue.push(progress('b')).seq).toBe(2)
    expect(queue.cursor).toBe(2)
  })

  it('stamps ts from the injected clock', () => {
    const queue = new EventQueue(10, () => 4242)
    expect(queue.push(progress('a')).ts).toBe(4242)
  })

  it('returns only events newer than the cursor', () => {
    const queue = new EventQueue()
    queue.push(progress('a'))
    queue.push(progress('b'))
    expect(queue.since(0).map((e) => e.seq)).toEqual([1, 2])
    expect(queue.since(1).map((e) => e.seq)).toEqual([2])
    expect(queue.since(2)).toEqual([])
  })

  it('drops the oldest events once capacity is exceeded but keeps seq honest', () => {
    const queue = new EventQueue(3)
    for (let i = 0; i < 5; i++) queue.push(progress(`n${i}`))
    expect(queue.size).toBe(3)
    expect(queue.all().map((e) => e.seq)).toEqual([3, 4, 5])
    // A stale cursor sees the surviving tail; the seq gap makes the loss visible.
    expect(queue.since(1).map((e) => e.seq)).toEqual([3, 4, 5])
  })

  it('resolves wait() synchronously when events are already buffered', async () => {
    const queue = new EventQueue()
    queue.push(progress('a'))
    let settled = false
    const promise = queue.wait(0, 60_000).then((events) => {
      settled = true
      return events
    })
    expect(queue.waiterCount).toBe(0)
    await expect(promise).resolves.toHaveLength(1)
    expect(settled).toBe(true)
  })

  it('wakes a parked waiter in the same tick as the push (no polling)', async () => {
    const queue = new EventQueue()
    const pending = queue.wait(0, 60_000)
    expect(queue.waiterCount).toBe(1)

    const startedAt = Date.now()
    queue.push(progress('late'))
    const events = await pending

    expect(events.map((e) => (e.type === 'agent_progress' ? e.note : ''))).toEqual(['late'])
    expect(Date.now() - startedAt).toBeLessThan(50)
    expect(queue.waiterCount).toBe(0)
  })

  it('gives each waiter exactly the events it missed', async () => {
    const queue = new EventQueue()
    queue.push(progress('first'))
    // A cursor behind the buffer never parks — it gets its backlog at once.
    const fromZero = queue.wait(0, 1_000)
    // A cursor at the head parks and receives only what arrives afterwards.
    const fromOne = queue.wait(1, 1_000)
    expect(queue.waiterCount).toBe(1)
    queue.push(progress('second'))

    expect((await fromZero).map((e) => e.seq)).toEqual([1])
    expect((await fromOne).map((e) => e.seq)).toEqual([2])
  })

  it('resolves with an empty list on timeout and unparks the waiter', async () => {
    vi.useFakeTimers()
    try {
      const queue = new EventQueue()
      const pending = queue.wait(0, 500)
      expect(queue.waiterCount).toBe(1)
      await vi.advanceTimersByTimeAsync(500)
      await expect(pending).resolves.toEqual([])
      expect(queue.waiterCount).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('resolves empty immediately for a non-positive timeout', async () => {
    const queue = new EventQueue()
    await expect(queue.wait(0, 0)).resolves.toEqual([])
    expect(queue.waiterCount).toBe(0)
  })

  it('unparks on abort and removes its abort listener', async () => {
    const queue = new EventQueue()
    const controller = new AbortController()
    const pending = queue.wait(0, 60_000, controller.signal)
    expect(queue.waiterCount).toBe(1)
    controller.abort()
    await expect(pending).resolves.toEqual([])
    expect(queue.waiterCount).toBe(0)
    // Aborting again must not resolve a stale waiter or throw.
    controller.abort()
    expect(queue.waiterCount).toBe(0)
  })

  it('resolves immediately when the signal is already aborted', async () => {
    const queue = new EventQueue()
    await expect(queue.wait(0, 60_000, AbortSignal.abort())).resolves.toEqual([])
    expect(queue.waiterCount).toBe(0)
  })

  it('releases every waiter on close and refuses further pushes', async () => {
    const queue = new EventQueue()
    const pending = queue.wait(0, 60_000)
    queue.close()
    await expect(pending).resolves.toEqual([])
    expect(queue.waiterCount).toBe(0)
    expect(queue.isClosed).toBe(true)
    expect(() => queue.push(progress('a'))).toThrow(/closed/)
    await expect(queue.wait(0, 60_000)).resolves.toEqual([])
  })

  it('survives a waiter that re-registers from inside its own resolve', async () => {
    const queue = new EventQueue()
    const seen: number[] = []
    const done = queue.wait(0, 1_000).then((events) => {
      seen.push(...events.map((e) => e.seq))
      return queue.wait(events.at(-1)!.seq, 1_000)
    })
    queue.push(progress('a'))
    queue.push(progress('b'))
    const second = await done
    expect(seen).toEqual([1])
    expect(second.map((e) => e.seq)).toEqual([2])
  })

  it('rejects a capacity below one', () => {
    expect(() => new EventQueue(0)).toThrow(/capacity/)
  })
})
