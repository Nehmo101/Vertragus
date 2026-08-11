import { describe, expect, it, vi } from 'vitest'
import {
  SUBMIT_KEY,
  seedOptionsFromProvider,
  seedWithReadyHandshake,
  waitForInteractiveReady
} from './interactiveReady'

/** A task contract is always multi-line — the shape that triggered the bug. */
const MULTILINE_TASK = ['line one', 'line two'].join('\n')

const fastReady = {
  ready: { timeoutMs: 500, idleMs: 20, minChars: 8, pollMs: 10 } as const
}

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
    const buffer = 'interactive cli ready'
    await expect(seedWithReadyHandshake(
      write,
      () => ({ buffer, alive: true }),
      'seed prompt',
      {
        ...fastReady,
        maxAttempts: 2,
        retryDelayMs: 20,
        acceptancePollMs: 5,
        submitDelayMs: 5,
        // Static buffer would otherwise look like a swallowed Enter.
        submitRetries: 1
      }
    )).resolves.toBe(true)
    // Two attempts at the text, then ONE Enter — not one Enter per attempt.
    expect(write.mock.calls.map((call) => call[0])).toEqual([
      'seed prompt',
      'seed prompt',
      SUBMIT_KEY
    ])
  })

  it('does not send the seed again after the interactive CLI reacts', async () => {
    let buffer = 'interactive cli ready'
    const write = vi.fn((_text: string) => {
      buffer += '\nseed accepted'
    })

    await expect(
      seedWithReadyHandshake(write, () => ({ buffer, alive: true }), 'seed prompt', {
        ...fastReady,
        maxAttempts: 3,
        retryDelayMs: 50,
        acceptancePollMs: 5,
        submitDelayMs: 5,
        submitRetries: 1
      })
    ).resolves.toBe(true)
    expect(write.mock.calls.map((call) => call[0])).toEqual(['seed prompt', SUBMIT_KEY])
  })

  /**
   * The bug from the first real run: Claude Code puts a multi-line paste into
   * its composer and reads a carriage return that arrives in the same burst as
   * a newline of that paste, not as "send". The task then sat there, unsent,
   * waiting for a human to press Enter.
   */
  it('sends the submitting Enter as its own later write, never glued to the text', async () => {
    const at: number[] = []
    const write = vi.fn((_text: string) => {
      at.push(Date.now())
    })

    await seedWithReadyHandshake(
      write,
      () => ({ buffer: 'interactive cli ready', alive: true }),
      MULTILINE_TASK,
      {
        ...fastReady,
        maxAttempts: 1,
        submitDelayMs: 120,
        submitRetries: 1
      }
    )

    expect(write.mock.calls.map((call) => call[0])).toEqual([MULTILINE_TASK, SUBMIT_KEY])
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(100)
  })

  it('leaves the assignment unsent when autoSubmit is off', async () => {
    const write = vi.fn()

    await expect(
      seedWithReadyHandshake(write, () => ({ buffer: 'ready>', alive: true }), 'seed prompt', {
        ready: { timeoutMs: 500, idleMs: 20, minChars: 4, pollMs: 10 },
        maxAttempts: 1,
        autoSubmit: false,
        submitRetries: 3
      })
    ).resolves.toBe(true)
    expect(write.mock.calls.map((call) => call[0])).toEqual(['seed prompt'])
  })

  it('never doubles the return when the caller already terminated the prompt', async () => {
    const write = vi.fn()

    await seedWithReadyHandshake(
      write,
      () => ({ buffer: 'ready>', alive: true }),
      `seed prompt${SUBMIT_KEY}`,
      {
        ready: { timeoutMs: 500, idleMs: 20, minChars: 4, pollMs: 10 },
        maxAttempts: 1,
        submitDelayMs: 5,
        submitRetries: 1
      }
    )
    expect(write.mock.calls.map((call) => call[0])).toEqual(['seed prompt', SUBMIT_KEY])
  })

  it('does not press Enter into a CLI that died between text and submit', async () => {
    let alive = true
    const write = vi.fn(() => {
      alive = false
    })

    await expect(
      seedWithReadyHandshake(write, () => ({ buffer: 'ready>', alive }), 'seed prompt', {
        ready: { timeoutMs: 500, idleMs: 20, minChars: 4, pollMs: 10 },
        maxAttempts: 1,
        submitDelayMs: 5
      })
    ).resolves.toBe(false)
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('does not seed a process that exited before becoming ready', async () => {
    const write = vi.fn()

    await expect(
      seedWithReadyHandshake(write, () => ({ buffer: '', alive: false }), 'seed prompt', {
        ready: { timeoutMs: 50, pollMs: 5 }
      })
    ).resolves.toBe(false)
    expect(write).not.toHaveBeenCalled()
  })

  it('resends Enter when the buffer stays unchanged after the first submit', async () => {
    const write = vi.fn()
    const buffer = 'interactive cli ready'

    await seedWithReadyHandshake(write, () => ({ buffer, alive: true }), 'seed prompt', {
      ...fastReady,
      maxAttempts: 1,
      submitDelayMs: 5,
      submitWatchMs: 30,
      submitRetries: 3,
      acceptancePollMs: 5
    })

    const submits = write.mock.calls.map((call) => call[0]).filter((value) => value === SUBMIT_KEY)
    expect(submits).toHaveLength(3)
    expect(write.mock.calls.map((call) => call[0])).toEqual([
      'seed prompt',
      SUBMIT_KEY,
      SUBMIT_KEY,
      SUBMIT_KEY
    ])
  })

  it('does not resend Enter once the buffer reacts to the first submit', async () => {
    let buffer = 'interactive cli ready'
    const write = vi.fn((text: string) => {
      if (text === SUBMIT_KEY) buffer += '\nsubmitted'
    })

    await seedWithReadyHandshake(write, () => ({ buffer, alive: true }), 'seed prompt', {
      ...fastReady,
      maxAttempts: 1,
      submitDelayMs: 5,
      submitWatchMs: 40,
      submitRetries: 3,
      acceptancePollMs: 5
    })

    expect(write.mock.calls.map((call) => call[0])).toEqual(['seed prompt', SUBMIT_KEY])
  })

  it('caps Enter retries at submitRetries', async () => {
    const write = vi.fn()
    const buffer = 'interactive cli ready'

    await seedWithReadyHandshake(write, () => ({ buffer, alive: true }), 'seed prompt', {
      ...fastReady,
      maxAttempts: 1,
      submitDelayMs: 5,
      submitWatchMs: 20,
      submitRetries: 2,
      acceptancePollMs: 5
    })

    expect(write.mock.calls.filter((call) => call[0] === SUBMIT_KEY)).toHaveLength(2)
  })
})

describe('seedOptionsFromProvider', () => {
  it('maps only the fields the provider declared', () => {
    expect(seedOptionsFromProvider(undefined)).toEqual({})
    expect(seedOptionsFromProvider({ submitDelayMs: 750 })).toEqual({ submitDelayMs: 750 })
    expect(
      seedOptionsFromProvider({ submitDelayMs: 750, submitRetries: 3, submitWatchMs: 800 })
    ).toEqual({ submitDelayMs: 750, submitRetries: 3, submitWatchMs: 800 })
  })
})
