import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BRACKETED_PASTE_OFF,
  BRACKETED_PASTE_ON,
  PASTE_BEGIN,
  PASTE_END,
  SUBMIT_KEY,
  bracketedPasteActive,
  pasteBody,
  seedNewlines,
  seedOptionsFromProvider,
  seedWithReadyHandshake,
  waitForInteractiveReady,
  waitForKeyboardTaken
} from './interactiveReady'

const APP_CONTROL_DUMP = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'cursor-agent-app-control.txt'),
  'utf8'
)

/** A task contract is always multi-line — the shape that triggered the bug. */
const MULTILINE_TASK = ['line one', 'line two'].join('\n')

const fastReady = {
  ready: { timeoutMs: 500, idleMs: 20, minChars: 8, pollMs: 10, keyboardMs: 50 } as const
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
      { timeoutMs: 2000, idleMs: 80, minChars: 10, pollMs: 20, keyboardMs: 40 }
    )
    setTimeout(() => {
      buffer = 'booting cli'
    }, 30)
    setTimeout(() => {
      buffer = 'booting cli · prompt ready'
    }, 60)
    await expect(ready).resolves.toBe(true)
  })

  /**
   * The Kimi regression, measured: `kimi` prints its first bytes after 76 ms
   * and takes the keyboard after 3 783 ms. The idle heuristic alone therefore
   * declared readiness while nothing was listening, and the whole assignment
   * was written into a void — it appeared in the scrollback ahead of Kimi's
   * own welcome box and the composer stayed empty.
   */
  it('waits for the CLI to take the keyboard, not merely for a quiet banner', async () => {
    let buffer = 'kimi booting…'
    let readyAt = 0
    const ready = waitForInteractiveReady(() => ({ buffer, alive: true }), {
      timeoutMs: 2_000,
      idleMs: 30,
      minChars: 4,
      pollMs: 5,
      keyboardMs: 1_000
    }).then((value) => {
      readyAt = Date.now()
      return value
    })

    // Banner quiet for far longer than idleMs — the old gate would fire here.
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(readyAt).toBe(0)

    const tookKeyboardAt = Date.now()
    buffer += BRACKETED_PASTE_ON
    await expect(ready).resolves.toBe(true)
    expect(readyAt).toBeGreaterThanOrEqual(tookKeyboardAt)
  })

  it('falls back to the idle heuristic for a CLI that never announces', async () => {
    // A plain REPL (`ollama run`) reads stdin from its first prompt onwards and
    // never enables bracketed paste. Spending the cap must not fail readiness.
    await expect(
      waitForInteractiveReady(() => ({ buffer: 'plain repl ready>', alive: true }), {
        timeoutMs: 500,
        idleMs: 20,
        minChars: 4,
        pollMs: 5,
        keyboardMs: 60
      })
    ).resolves.toBe(true)
  })

  it('gives up on the keyboard wait as soon as the process dies', async () => {
    await expect(
      waitForKeyboardTaken(() => ({ buffer: 'booting', alive: false }), 5_000, 5)
    ).resolves.toBe(false)
  })

  it('gives up on the keyboard wait as soon as Application Control blocks a native addon', async () => {
    const started = Date.now()
    await expect(
      waitForKeyboardTaken(() => ({ buffer: APP_CONTROL_DUMP, alive: true }), 5_000, 5)
    ).resolves.toBe(false)
    expect(Date.now() - started).toBeLessThan(400)
  })

  it('returns false when agent is no longer alive', async () => {
    await expect(
      waitForInteractiveReady(() => ({ buffer: '', alive: false }), {
        timeoutMs: 200,
        pollMs: 20
      })
    ).resolves.toBe(false)
  })

  /**
   * The idle heuristic would otherwise treat the crash dump as a quiet banner
   * (plenty of characters, then silence) and the handshake would paste the
   * orchestrator prompt on top of it — which is how "never became ready"
   * hid a Windows Application Control block.
   */
  it('does not treat an Application Control crash dump as a ready banner', async () => {
    const started = Date.now()
    await expect(
      waitForInteractiveReady(() => ({ buffer: APP_CONTROL_DUMP, alive: true }), {
        timeoutMs: 2_000,
        idleMs: 20,
        minChars: 8,
        pollMs: 10,
        keyboardMs: 2_000
      })
    ).resolves.toBe(false)
    expect(Date.now() - started).toBeLessThan(400)
  })

  it('does not paste into a CLI blocked by Application Control', async () => {
    const write = vi.fn()
    await expect(
      seedWithReadyHandshake(
        write,
        () => ({ buffer: APP_CONTROL_DUMP, alive: true }),
        'orchestrator prompt',
        { ready: { timeoutMs: 500, idleMs: 20, minChars: 8, pollMs: 10, keyboardMs: 2_000 } }
      )
    ).resolves.toBe(false)
    expect(write).not.toHaveBeenCalled()
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
        ready: { timeoutMs: 500, idleMs: 20, minChars: 4, pollMs: 10, keyboardMs: 50 },
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
        ready: { timeoutMs: 500, idleMs: 20, minChars: 4, pollMs: 10, keyboardMs: 50 },
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
        ready: { timeoutMs: 500, idleMs: 20, minChars: 4, pollMs: 10, keyboardMs: 50 },
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
        ready: { timeoutMs: 50, pollMs: 5, keyboardMs: 20 }
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
        ready: { timeoutMs: 500, idleMs: 20, minChars: 4, pollMs: 10, keyboardMs: 50 }
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
          ready: { timeoutMs: 60, idleMs: 20, minChars: 4, pollMs: 5, keyboardMs: 20 },
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

/**
 * Bracketed paste — the half of the Cursor bug that timing could not reach.
 *
 * A raw multi-KB write is a keystroke stream: the PTY splits it into
 * read-sized chunks and a `\n` that lands on a chunk boundary is decoded as
 * Enter, submitting a fragment of the assignment. DECSET 2004 is the terminal
 * protocol for saying "this is text, not keys", and a TUI announces it by
 * emitting ESC[?2004h when it takes the keyboard.
 */
describe('bracketed paste', () => {
  it('reads the CLI’s last DECSET 2004 as its current state', () => {
    expect(bracketedPasteActive('no announcement here')).toBe(false)
    expect(bracketedPasteActive(`boot${BRACKETED_PASTE_ON}ready`)).toBe(true)
    // Handed the keyboard back (shelled out, exiting) — pastes are keys again.
    expect(bracketedPasteActive(`${BRACKETED_PASTE_ON}ready${BRACKETED_PASTE_OFF}`)).toBe(false)
    // …and taken it again. Last one wins, not "was it ever on".
    expect(
      bracketedPasteActive(`${BRACKETED_PASTE_ON}a${BRACKETED_PASTE_OFF}b${BRACKETED_PASTE_ON}`)
    ).toBe(true)
  })

  it('never lets the prompt text end its own paste', () => {
    // A prompt that quotes terminal escapes would otherwise close the bracket
    // early and turn its own remainder back into keystrokes.
    expect(pasteBody(`before${PASTE_END}after`)).toBe('beforeafter')
    expect(pasteBody(`before${PASTE_BEGIN}after`)).toBe('beforeafter')
  })

  it('never sends a CR inside the assignment — that is the submit key', () => {
    // A role prompt edited on Windows is CRLF, and every one of those CRs is
    // an Enter nobody pressed: it submits a fragment and strands the rest.
    expect(seedNewlines('line one\r\nline two\rline three')).toBe('line one\nline two\nline three')
    expect(pasteBody('line one\r\nline two')).toBe('line one\nline two')
  })

  it('normalises the newlines of a raw write too, not only of a paste', async () => {
    const write = vi.fn()

    await seedWithReadyHandshake(
      write,
      () => ({ buffer: 'plain repl ready', alive: true }),
      'line one\r\nline two',
      {
        ...fastReady,
        ...fastSettle,
        submitDelayMs: 5,
        submitWatchMs: 20,
        submitRetries: 1,
        acceptancePollMs: 5
      }
    )

    expect(write.mock.calls.map((call) => call[0])).toEqual(['line one\nline two', SUBMIT_KEY])
  })

  it('frames the assignment once the CLI has announced DECSET 2004', async () => {
    const buffer = `cursor-agent ready${BRACKETED_PASTE_ON}`
    const write = vi.fn()

    await seedWithReadyHandshake(write, () => ({ buffer, alive: true }), MULTILINE_TASK, {
      ...fastReady,
      ...fastSettle,
      submitDelayMs: 5,
      submitWatchMs: 20,
      submitRetries: 1,
      acceptancePollMs: 5
    })

    // The whole block in one framed write, and the Enter still on its own —
    // the only keypress in the sequence.
    expect(write.mock.calls.map((call) => call[0])).toEqual([
      `${PASTE_BEGIN}${MULTILINE_TASK}${PASTE_END}`,
      SUBMIT_KEY
    ])
  })

  it('writes raw text to a CLI that never asked for bracketed pastes', async () => {
    const buffer = 'plain repl ready'
    const write = vi.fn()

    await seedWithReadyHandshake(write, () => ({ buffer, alive: true }), MULTILINE_TASK, {
      ...fastReady,
      ...fastSettle,
      submitDelayMs: 5,
      submitWatchMs: 20,
      submitRetries: 1,
      acceptancePollMs: 5
    })

    expect(write.mock.calls.map((call) => call[0])).toEqual([MULTILINE_TASK, SUBMIT_KEY])
  })

  it('honours the opt-out even when the CLI announced it', async () => {
    const buffer = `announces it${BRACKETED_PASTE_ON}`
    const write = vi.fn()

    await seedWithReadyHandshake(write, () => ({ buffer, alive: true }), MULTILINE_TASK, {
      ...fastReady,
      ...fastSettle,
      bracketedPaste: 'never',
      submitDelayMs: 5,
      submitWatchMs: 20,
      submitRetries: 1,
      acceptancePollMs: 5
    })

    expect(write.mock.calls.map((call) => call[0])).toEqual([MULTILINE_TASK, SUBMIT_KEY])
  })
})

/**
 * The seed used to report every delivery as a success, including the ones
 * where all bounded Enters were spent on a TUI that never reacted — so a
 * silent agent looked exactly like a working one.
 */
describe('onSubmitted', () => {
  it('reports an Enter that was never accepted', async () => {
    const buffer = 'interactive cli ready'
    const onSubmitted = vi.fn()

    await expect(
      seedWithReadyHandshake(vi.fn(), () => ({ buffer, alive: true }), 'seed prompt', {
        ...fastReady,
        ...fastSettle,
        submitDelayMs: 5,
        submitWatchMs: 30,
        submitRetries: 2,
        acceptancePollMs: 5,
        onSubmitted
      })
      // The text did reach a live CLI — that verdict is unchanged.
    ).resolves.toBe(true)

    expect(onSubmitted).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('reports an Enter the TUI answered with a running turn', async () => {
    let buffer = 'interactive cli ready'
    let spinner: ReturnType<typeof setInterval> | undefined
    const onSubmitted = vi.fn()
    const write = vi.fn((text: string) => {
      if (text !== SUBMIT_KEY || spinner) return
      spinner = setInterval(() => {
        buffer += '·'
      }, 5)
    })

    try {
      await seedWithReadyHandshake(write, () => ({ buffer, alive: true }), 'seed prompt', {
        ...fastReady,
        ...fastSettle,
        submitDelayMs: 5,
        submitWatchMs: 60,
        submitRetries: 3,
        acceptancePollMs: 5,
        onSubmitted
      })
    } finally {
      if (spinner) clearInterval(spinner)
    }

    expect(onSubmitted).toHaveBeenCalledExactlyOnceWith(true)
    // One Enter was enough — the retries must not have fired.
    expect(write.mock.calls.filter((call) => call[0] === SUBMIT_KEY)).toHaveLength(1)
  })

  it('says nothing at all when the caller asked for no Enter', async () => {
    const onSubmitted = vi.fn()

    await seedWithReadyHandshake(
      vi.fn(),
      () => ({ buffer: 'interactive cli ready', alive: true }),
      'seed prompt',
      { ...fastReady, ...fastSettle, autoSubmit: false, acceptancePollMs: 5, onSubmitted }
    )

    expect(onSubmitted).not.toHaveBeenCalled()
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
        submitAcceptance: 'sustained-activity',
        bracketedPaste: 'auto'
      })
    ).toEqual({
      submitDelayMs: 750,
      submitRetries: 3,
      submitWatchMs: 2500,
      submitAcceptance: 'sustained-activity',
      bracketedPaste: 'auto'
    })
  })

  it('carries the keyboard-wait opt-out into the readiness options', () => {
    // 0 is a value, not an omission: `ollama run` never announces DECSET 2004.
    expect(seedOptionsFromProvider({ keyboardWaitMs: 0 })).toEqual({ ready: { keyboardMs: 0 } })
  })
})
