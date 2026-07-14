import { describe, expect, it } from 'vitest'
import { Semaphore } from './semaphore'

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('Semaphore', () => {
  it('caps concurrency at the limit and hands freed slots to waiters in order', async () => {
    const sem = new Semaphore(2)
    const order: number[] = []
    await sem.acquire()
    await sem.acquire()
    const third = sem.acquire().then(() => order.push(3))
    const fourth = sem.acquire().then(() => order.push(4))
    await settle()
    expect(order).toEqual([])
    expect(sem.inUse).toBe(2)
    expect(sem.waiting).toBe(2)

    sem.release()
    sem.release()
    await Promise.all([third, fourth])
    expect(order).toEqual([3, 4])
    expect(sem.inUse).toBe(2)
  })

  it('raising the limit lets queued waiters through immediately', async () => {
    const sem = new Semaphore(1)
    await sem.acquire()
    let granted = false
    const waiter = sem.acquire().then(() => {
      granted = true
    })
    await settle()
    expect(granted).toBe(false)

    sem.setLimit(2)
    await waiter
    expect(granted).toBe(true)
    expect(sem.inUse).toBe(2)
  })

  it('a lowered limit shrinks active use before any waiter resumes', async () => {
    const sem = new Semaphore(3)
    await sem.acquire()
    await sem.acquire()
    await sem.acquire()
    let granted = false
    const waiter = sem.acquire().then(() => {
      granted = true
    })

    sem.setLimit(1)
    sem.release() // 3 -> 2, still over the limit: must not wake the waiter
    await settle()
    expect(granted).toBe(false)
    expect(sem.inUse).toBe(2)

    sem.release() // 2 -> 1, at the limit: still no free slot for the waiter
    await settle()
    expect(granted).toBe(false)
    expect(sem.inUse).toBe(1)

    sem.release() // 1 active at limit 1: the freed slot goes to the waiter
    await waiter
    expect(granted).toBe(true)
    expect(sem.inUse).toBe(1)
  })

  it('release without waiters never drives the counter negative', () => {
    const sem = new Semaphore(1)
    sem.release()
    expect(sem.inUse).toBe(0)
  })
})
