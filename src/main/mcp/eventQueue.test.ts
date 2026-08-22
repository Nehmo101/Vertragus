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

  it('names the dropped seq range instead of leaving readers to infer it', () => {
    const queue = new EventQueue(3)
    for (let i = 0; i < 5; i++) queue.push(progress(`n${i}`))
    // Buffer holds 3..5; a reader from the beginning lost 1..2.
    expect(queue.droppedSince(0)).toEqual({ from: 1, to: 2 })
    expect(queue.droppedSince(1)).toEqual({ from: 2, to: 2 })
    // A reader at the ring edge or newer lost nothing.
    expect(queue.droppedSince(2)).toBeUndefined()
    expect(queue.droppedSince(5)).toBeUndefined()
  })

  it('reports no drop on an empty or un-overflowed queue', () => {
    const empty = new EventQueue(3)
    expect(empty.droppedSince(0)).toBeUndefined()
    const filled = new EventQueue(3)
    filled.push(progress('a'))
    expect(filled.droppedSince(0)).toBeUndefined()
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

describe('quiet events — S2', () => {
  it('stamps quiet only when asked — never a quiet key on a normal event', () => {
    const queue = new EventQueue()
    const loud = queue.push(progress('loud'))
    expect('quiet' in loud).toBe(false)
    const quiet = queue.push(progress('quiet'), { quiet: true })
    expect(quiet.quiet).toBe(true)
    // `quiet: false` must not leak a key either — journals stay clean.
    const explicit = queue.push(progress('explicit'), { quiet: false })
    expect('quiet' in explicit).toBe(false)
  })

  it('does not wake a parked waiter', async () => {
    const queue = new EventQueue()
    const pending = queue.wait(0, 1_000)
    expect(queue.waiterCount).toBe(1)
    queue.push(progress('echo'), { quiet: true })
    // Still parked — the quiet push resolved nothing.
    expect(queue.waiterCount).toBe(1)
    queue.push(progress('real'))
    const events = await pending
    // ...but the wake delivers the quiet event along with the real one.
    expect(events.map((e) => e.quiet ?? false)).toEqual([true, false])
    expect(events.map((e) => e.seq)).toEqual([1, 2])
  })

  it('parks instead of resolving on a quiet-only backlog', async () => {
    const queue = new EventQueue()
    queue.push(progress('echo'), { quiet: true })
    const pending = queue.wait(0, 1_000)
    expect(queue.waiterCount).toBe(1)
    queue.push(progress('real'))
    expect((await pending).map((e) => e.seq)).toEqual([1, 2])
  })

  it('resolves immediately when the backlog holds at least one non-quiet event', async () => {
    const queue = new EventQueue()
    queue.push(progress('echo'), { quiet: true })
    queue.push(progress('real'))
    const events = await queue.wait(0, 60_000)
    expect(queue.waiterCount).toBe(0)
    expect(events.map((e) => e.seq)).toEqual([1, 2])
  })

  it('delivers quiet events on timeout so the cursor advances past them', async () => {
    vi.useFakeTimers()
    try {
      const queue = new EventQueue()
      queue.push(progress('echo'), { quiet: true })
      const pending = queue.wait(0, 500)
      expect(queue.waiterCount).toBe(1)
      await vi.advanceTimersByTimeAsync(500)
      const events = await pending
      expect(events.map((e) => e.seq)).toEqual([1])
      // The advanced cursor means a re-ask does not see the quiet event again.
      await expect(queue.wait(events.at(-1)!.seq, 0)).resolves.toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('a quiet event pushed while parked still arrives with the timeout', async () => {
    vi.useFakeTimers()
    try {
      const queue = new EventQueue()
      const pending = queue.wait(0, 500)
      queue.push(progress('echo'), { quiet: true })
      await vi.advanceTimersByTimeAsync(500)
      expect((await pending).map((e) => e.seq)).toEqual([1])
    } finally {
      vi.useRealTimers()
    }
  })

  it('onPush listeners see quiet events immediately', () => {
    const queue = new EventQueue()
    const seen: number[] = []
    queue.onPush((event) => seen.push(event.seq))
    queue.push(progress('echo'), { quiet: true })
    expect(seen).toEqual([1])
  })

  it('handles quiet→wake→quiet: the trailing quiet waits for the next exit', async () => {
    vi.useFakeTimers()
    try {
      const queue = new EventQueue()
      queue.push(progress('q1'), { quiet: true })
      const first = queue.wait(0, 60_000)
      queue.push(progress('real'))
      expect((await first).map((e) => e.seq)).toEqual([1, 2])

      queue.push(progress('q2'), { quiet: true })
      const second = queue.wait(2, 500)
      expect(queue.waiterCount).toBe(1)
      await vi.advanceTimersByTimeAsync(500)
      expect((await second).map((e) => e.seq)).toEqual([3])
    } finally {
      vi.useRealTimers()
    }
  })

  it('delivers the quiet backlog on abort — same rule as the timeout exit', async () => {
    const queue = new EventQueue()
    const controller = new AbortController()
    const pending = queue.wait(0, 60_000, controller.signal)
    queue.push(progress('echo'), { quiet: true })
    controller.abort()
    expect((await pending).map((e) => e.seq)).toEqual([1])
    expect(queue.waiterCount).toBe(0)
  })

  it('an already-aborted signal still yields the quiet backlog', async () => {
    const queue = new EventQueue()
    queue.push(progress('echo'), { quiet: true })
    const events = await queue.wait(0, 60_000, AbortSignal.abort())
    expect(events.map((e) => e.seq)).toEqual([1])
  })

  it('delivers the quiet backlog on close — nothing is lost at shutdown', async () => {
    const queue = new EventQueue()
    const pending = queue.wait(0, 60_000)
    queue.push(progress('echo'), { quiet: true })
    queue.close()
    expect((await pending).map((e) => e.seq)).toEqual([1])
    expect(queue.waiterCount).toBe(0)
  })
})

describe('onPush', () => {
  it('sees every event, beyond the ring capacity, until unsubscribed', () => {
    const queue = new EventQueue(2)
    const seen: number[] = []
    const off = queue.onPush((event) => seen.push(event.seq))

    for (let i = 0; i < 5; i += 1) {
      queue.push({ type: 'agent_progress', agentId: 'a1', name: 'A', roleId: 'worker', note: `${i}` })
    }
    // The ring dropped the early events; the tap kept them all.
    expect(queue.all()).toHaveLength(2)
    expect(seen).toEqual([1, 2, 3, 4, 5])

    off()
    queue.push({ type: 'agent_progress', agentId: 'a1', name: 'A', roleId: 'worker', note: 'late' })
    expect(seen).toHaveLength(5)
  })

  it('drops all listeners on close', () => {
    const queue = new EventQueue()
    const seen: number[] = []
    queue.onPush((event) => seen.push(event.seq))
    queue.close()
    expect(() =>
      queue.push({ type: 'agent_progress', agentId: 'a1', name: 'A', roleId: 'worker', note: 'x' })
    ).toThrow()
    expect(seen).toHaveLength(0)
  })
})
