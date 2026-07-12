import { describe, expect, it, vi } from 'vitest'
import { seedWithReadyHandshake, waitForInteractiveReady } from './interactiveReady'

describe('interactiveReady', () => {
  it('waits until buffer is idle with enough output', async () => {
    let buffer = ''
    const ready = waitForInteractiveReady(
      () => ({ buffer, alive: true }),
      { timeoutMs: 2000, idleMs: 80, minChars: 10, pollMs: 20 }
    )
    setTimeout(() => {
      buffer = 'booting cli'
    }, 30)
    setTimeout(() => {
      buffer = 'booting cli · prompt ready'
    }, 60)
    await expect(ready).resolves.toBe(true)
  })

  it('returns false when agent is no longer alive', async () => {
    await expect(
      waitForInteractiveReady(() => ({ buffer: '', alive: false }), {
        timeoutMs: 200,
        pollMs: 20
      })
    ).resolves.toBe(false)
  })

  it('seeds with bounded retries after ready handshake', async () => {
    const write = vi.fn()
    let buffer = 'interactive cli ready'
    await seedWithReadyHandshake(
      write,
      () => ({ buffer, alive: true }),
      'seed prompt',
      { ready: { timeoutMs: 500, idleMs: 20, minChars: 8, pollMs: 10 }, maxAttempts: 2 }
    )
    expect(write).toHaveBeenCalledTimes(2)
    expect(write.mock.calls[0]?.[0]).toBe('seed prompt\r')
  })
})
