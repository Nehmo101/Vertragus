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

/**
 * The pre-measurement mode. These options pin the tests below to
 * 'buffer-change' semantics explicitly — the default is 'sustained-activity',
 * and what these tests document is the opt-out contract, not the default.
 */
const bufferChange = {
  submitAcceptance: 'buffer-change' as const
}

/** Fast settle timings so 'sustained-activity' paths never idle for real. */
const fastSettle = {
  settleIdleMs: 10,
  settleTimeoutMs: 200
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
        ...bufferChange,
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
        ...bufferChange,
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
        ...bufferChange,
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
        ...fastSettle,
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
        ...fastSettle,
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
        ...fastSettle,
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
      ...bufferChange,
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
      ...bufferChange,
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
      ...bufferChange,
      maxAttempts: 1,
      submitDelayMs: 5,
      submitWatchMs: 20,
      submitRetries: 2,
      acceptancePollMs: 5
    })

    expect(write.mock.calls.filter((call) => call[0] === SUBMIT_KEY)).toHaveLength(2)
  })
})

/**
 * The cursor-agent mode. Every scenario below replays a behaviour measured
 * against the real CLI (v2026.08.11) over a PTY:
 * - a swallowed Enter still triggers ONE redraw (the "[Pasted text …]" chip)
 *   and then silence — so 'buffer-change' reads the swallow as success,
 * - an accepted Enter starts a turn whose spinner streams for seconds,
 * - the TUI freezes >1s while digesting a multi-KB paste; text rewrites and
 *   Enters pressed into that freeze (or into a running turn) queue EXTRA
 *   follow-up turns.
 */
describe("submitAcceptance 'sustained-activity'", () => {
  const fastSustained = {
    ...fastReady,
    maxAttempts: 3,
    submitDelayMs: 5,
    submitWatchMs: 60, // sustain threshold = 30ms
    submitRetries: 3,
    acceptancePollMs: 5,
    settleIdleMs: 10,
    settleTimeoutMs: 300,
    submitAcceptance: 'sustained-activity' as const
  }

  it('retries Enter although every swallow produces a visible redraw', async () => {
    let buffer = 'interactive cli ready'
    // The TUI reacts to every write with one redraw burst — and then silence.
    // Under 'buffer-change' that single change would end the retries with the
    // task still sitting in the composer; here all bounded retries must fire.
    const write = vi.fn((_text: string) => {
      buffer += '\nredraw'
    })

    await expect(
      seedWithReadyHandshake(write, () => ({ buffer, alive: true }), 'seed prompt', fastSustained)
    ).resolves.toBe(true)

    // Text exactly once (maxAttempts 3 must not rewrite), then all 3 Enters.
    expect(write.mock.calls.map((call) => call[0])).toEqual([
      'seed prompt',
      SUBMIT_KEY,
      SUBMIT_KEY,
      SUBMIT_KEY
    ])
  })

  it('stops after one Enter once the TUI streams like a running turn', async () => {
    let buffer = 'interactive cli ready'
    let spinning: ReturnType<typeof setInterval> | undefined
    const write = vi.fn((text: string) => {
      buffer += '\nredraw'
      if (text === SUBMIT_KEY && !spinning) {
        // A submitted prompt starts a turn: continuous spinner output.
        spinning = setInterval(() => {
          buffer += ' ·spin'
        }, 3)
      }
    })

    try {
      await expect(
        seedWithReadyHandshake(write, () => ({ buffer, alive: true }), 'seed prompt', fastSustained)
      ).resolves.toBe(true)
    } finally {
      clearInterval(spinning)
    }

    // One Enter and no more: pressing again into a running turn queues the
    // composer content as an extra follow-up turn (observed live).
    expect(write.mock.calls.map((call) => call[0])).toEqual(['seed prompt', SUBMIT_KEY])
  })

  it('writes the text once into a frozen TUI and holds Enter until the thaw settles', async () => {
    let buffer = 'interactive cli ready'
    let thawedAt = 0
    const events: Array<{ what: string; at: number }> = []
    const write = vi.fn((text: string) => {
      events.push({ what: text, at: Date.now() })
      if (text !== SUBMIT_KEY) {
        // Digestion freeze: no echo at all, then one chip redraw much later.
        setTimeout(() => {
          thawedAt = Date.now()
          buffer += '\n[Pasted text #1 +152 lines]'
        }, 80)
      }
    })

    await expect(
      seedWithReadyHandshake(write, () => ({ buffer, alive: true }), 'seed prompt', {
        ...fastSustained,
        settleIdleMs: 20,
        settleTimeoutMs: 1000,
        submitRetries: 1
      })
    ).resolves.toBe(true)

    expect(write.mock.calls.map((call) => call[0])).toEqual(['seed prompt', SUBMIT_KEY])
    // The Enter waited for the thaw redraw plus the settle quiet time instead
    // of firing after a fixed delay into the freeze.
    const enter = events.find((event) => event.what === SUBMIT_KEY)!
    expect(thawedAt).toBeGreaterThan(0)
    expect(enter.at).toBeGreaterThanOrEqual(thawedAt + 15)
  })

  it('stops the sequence when the CLI dies after an Enter', async () => {
    let alive = true
    const write = vi.fn((text: string) => {
      if (text === SUBMIT_KEY) alive = false
    })

    await expect(
      seedWithReadyHandshake(write, () => ({ buffer: 'ready>', alive }), 'seed prompt', {
        ...fastSustained,
        ready: { timeoutMs: 500, idleMs: 20, minChars: 4, pollMs: 10 }
      })
    ).resolves.toBe(false)
    expect(write.mock.calls.filter((call) => call[0] === SUBMIT_KEY)).toHaveLength(1)
  })
})

/**
 * 'sustained-activity' is the DEFAULT, not cursor-only tuning: Claude Code
 * lost a task the same way live (two identical seeds seconds apart, one
 * landed, one left an empty composer — both reported accepted by the old
 * 'buffer-change' heuristic). These tests pass no submitAcceptance on purpose.
 */
describe('default acceptance', () => {
  it("retries Enter although a swallow produces a visible redraw — without opting in", async () => {
    let buffer = 'interactive cli ready'
    const write = vi.fn((_text: string) => {
      buffer += '\nredraw'
    })

    await expect(
      seedWithReadyHandshake(write, () => ({ buffer, alive: true }), 'seed prompt', {
        ...fastReady,
        maxAttempts: 3,
        submitDelayMs: 5,
        submitWatchMs: 60,
        submitRetries: 3,
        acceptancePollMs: 5,
        settleIdleMs: 10,
        settleTimeoutMs: 300
      })
    ).resolves.toBe(true)

    // Text exactly once despite maxAttempts 3, then all bounded Enters.
    expect(write.mock.calls.map((call) => call[0])).toEqual([
      'seed prompt',
      SUBMIT_KEY,
      SUBMIT_KEY,
      SUBMIT_KEY
    ])
  })

  it('holds the paste until a boot-busy TUI goes quiet', async () => {
    // The live Claude Code failure: readiness fell through on its timeout
    // while the TUI was still painting its boot, and the paste raced straight
    // into the busy CLI — which dropped it entirely. The settle gate must
    // delay the text write until the painting stops.
    let buffer = 'booting'
    const events: Array<{ what: string; at: number }> = []
    const write = vi.fn((text: string) => {
      events.push({ what: text, at: Date.now() })
    })
    let stoppedAt = 0
    const painting = setInterval(() => {
      buffer += ' ·boot'
    }, 5)
    setTimeout(() => {
      clearInterval(painting)
      stoppedAt = Date.now()
    }, 150)

    try {
      await expect(
        seedWithReadyHandshake(write, () => ({ buffer, alive: true }), 'seed prompt', {
          ready: { timeoutMs: 60, idleMs: 20, minChars: 4, pollMs: 5 },
          maxAttempts: 3,
          submitDelayMs: 5,
          submitWatchMs: 40,
          submitRetries: 1,
          acceptancePollMs: 5,
          settleIdleMs: 20,
          settleTimeoutMs: 400
        })
      ).resolves.toBe(true)
    } finally {
      clearInterval(painting)
    }

    expect(events[0]!.what).toBe('seed prompt')
    expect(stoppedAt).toBeGreaterThan(0)
    expect(events[0]!.at).toBeGreaterThanOrEqual(stoppedAt + 10)
  })
})

describe('seedOptionsFromProvider', () => {
  it('maps only the fields the provider declared', () => {
    expect(seedOptionsFromProvider(undefined)).toEqual({})
    expect(seedOptionsFromProvider({ submitDelayMs: 750 })).toEqual({ submitDelayMs: 750 })
    expect(
      seedOptionsFromProvider({
        submitDelayMs: 750,
        submitRetries: 3,
        submitWatchMs: 2500,
        submitAcceptance: 'sustained-activity'
      })
    ).toEqual({
      submitDelayMs: 750,
      submitRetries: 3,
      submitWatchMs: 2500,
      submitAcceptance: 'sustained-activity'
    })
  })
})
