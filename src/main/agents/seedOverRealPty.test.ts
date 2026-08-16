/**
 * The seed handshake against a REAL pty.
 *
 * Every other test in this folder feeds the handshake a fake snapshot, which
 * can prove what bytes it decides to write but never what the pty does with
 * them — and the pty is where the Cursor handover kept dying. A pty hands a
 * multi-KB write to the CLI in read-sized chunks, so a raw write is not a
 * paste: it is a keystroke stream, and every `\n` of a role prompt is decoded
 * as Enter. `scripts/paste-tui.mjs` is the smallest TUI that behaves the way
 * the protocol says (see its header), so these two cases are the before and
 * after of the fix, measured rather than argued.
 */
import { fileURLToPath, URL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PtyAgent } from './PtyAgent'
import { seedWithReadyHandshake, type SeedWithReadyOptions } from './interactiveReady'

const TUI = fileURLToPath(new URL('../../../scripts/paste-tui.mjs', import.meta.url))

/** Role prompt + task, the shape every PTY-delivery agent is seeded with. */
const ASSIGNMENT = ['You are a Worker.', '', 'Do this.', 'Then that.'].join('\n')

/** Real processes, so every window is wide enough to survive a slow runner. */
const OPTIONS: SeedWithReadyOptions = {
  // keyboardMs: the probe TUI announces DECSET 2004 immediately, so this is a
  // fallback bound and not a wait — a ConPTY build that hides the announcement
  // costs the test two seconds and still exercises the raw-write path.
  ready: { idleMs: 150, minChars: 4, pollMs: 20, timeoutMs: 5_000, keyboardMs: 2_000 },
  submitDelayMs: 100,
  submitRetries: 1,
  submitWatchMs: 500,
  settleIdleMs: 100,
  settleTimeoutMs: 2_000,
  acceptancePollMs: 10
}

/** Seed the probe TUI and return everything it reported as submitted. */
async function submitsAfterSeeding(options: SeedWithReadyOptions): Promise<string[]> {
  const pty = new PtyAgent()
  pty.spawn({ file: process.execPath, args: [TUI] })
  try {
    expect(await seedWithReadyHandshake(
      (data) => pty.write(data),
      () => ({ buffer: pty.snapshot(), alive: pty.isAlive }),
      ASSIGNMENT,
      { ...OPTIONS, ...options }
    )).toBe(true)
    // The TUI answers a submit within a tick; this is slack, not a race.
    await new Promise((resolve) => setTimeout(resolve, 300))
    return pty
      .snapshot()
      .split('\n')
      .filter((line) => line.startsWith('SUBMIT '))
      .map((line) => JSON.parse(line.slice('SUBMIT '.length).trim()) as string)
  } finally {
    pty.kill()
  }
}

describe('seeding over a real pty', () => {
  it('delivers a multi-line assignment as ONE submit, intact', async () => {
    expect(await submitsAfterSeeding({})).toEqual([ASSIGNMENT])
  }, 30_000)

  it.skipIf(process.platform === 'win32')(
    'shreds the same assignment into fragments without the paste framing',
    async () => {
      // What the handover actually did before: the role prompt goes off as its
      // own turn, the blank line as another, and the task arrives line by line —
      // an agent that was briefed with a quarter of its briefing. This is the
      // regression guard for `bracketedPaste`, not a behaviour anyone wants.
      //
      // Skipped on Windows: ConPTY drops CSI 200~/201~ and turns every `\n` into
      // a key event, so framed and unframed writes are indistinguishable. The
      // probe TUI then uses the same burst heuristic real composer CLIs do, and
      // both paths land as one submit.
      expect(await submitsAfterSeeding({ bracketedPaste: 'never' })).toEqual([
        'You are a Worker.',
        '',
        'Do this.',
        'Then that.'
      ])
    },
    30_000
  )
})
