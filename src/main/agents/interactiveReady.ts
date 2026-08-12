/**
 * Wait for an interactive agent PTY to finish booting before seeding prompts.
 * Uses output-idle detection instead of a fixed delay; seed writes are retried
 * a bounded number of times so a slow CLI still receives the briefing.
 */

export interface InteractiveSnapshot {
  buffer: string
  alive: boolean
}

export interface WaitForReadyOptions {
  timeoutMs?: number
  /** Ms of silence after the last buffer growth before treating the CLI as ready. */
  idleMs?: number
  minChars?: number
  pollMs?: number
}

const DEFAULT_WAIT: Required<WaitForReadyOptions> = {
  timeoutMs: 12_000,
  idleMs: 400,
  minChars: 24,
  pollMs: 100
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Returns true when the PTY emitted enough output and then went idle. */
export async function waitForInteractiveReady(
  getSnapshot: () => InteractiveSnapshot,
  options: WaitForReadyOptions = {}
): Promise<boolean> {
  const opts = { ...DEFAULT_WAIT, ...options }
  const deadline = Date.now() + opts.timeoutMs
  let lastLen = 0
  let lastChange = Date.now()

  while (Date.now() < deadline) {
    const { buffer, alive } = getSnapshot()
    if (!alive) return false
    if (buffer.length !== lastLen) {
      lastLen = buffer.length
      lastChange = Date.now()
    }
    if (buffer.length >= opts.minChars && Date.now() - lastChange >= opts.idleMs) {
      return true
    }
    await sleep(opts.pollMs)
  }

  const { buffer, alive } = getSnapshot()
  return alive && buffer.length > 0
}

/**
 * The submitting keystroke, written on its own.
 *
 * Not part of the prompt write, and not immediately after it: Claude Code (and
 * every other CLI with a multi-line composer) treats a `\r` that arrives inside
 * the same burst as the text as a *newline of the pasted block* and keeps the
 * whole thing in the input field. A separate, slightly later write arrives as
 * what it is — a keypress.
 */
export const SUBMIT_KEY = '\r'

/** Pause between the assignment text and the submitting Enter. */
export const DEFAULT_SUBMIT_DELAY_MS = 250

/**
 * How long to watch the PTY after each Enter before deciding it was swallowed.
 * Large PTY pastes (Cursor's role prompt + task) often need longer than the
 * initial delay alone — see {@link seedWithReadyHandshake}.
 */
export const DEFAULT_SUBMIT_WATCH_MS = 700

/** Max Enter presses including the first. */
export const DEFAULT_SUBMIT_RETRIES = 3

/**
 * `'sustained-activity'` only: quiet time after the last output before the TUI
 * counts as settled, and the cap on waiting for that settle. The cap keeps a
 * CLI that echoes nothing from stalling the seed forever.
 */
export const DEFAULT_SETTLE_IDLE_MS = 400
export const DEFAULT_SETTLE_TIMEOUT_MS = 5_000

/**
 * What counts as "the Enter was accepted" — see
 * {@link SeedWithReadyOptions.submitAcceptance}.
 */
export type SubmitAcceptance = 'buffer-change' | 'sustained-activity'

export interface SeedWithReadyOptions {
  ready?: WaitForReadyOptions
  maxAttempts?: number
  retryDelayMs?: number
  /** Poll interval while waiting for the CLI to react to a seed write. */
  acceptancePollMs?: number
  /**
   * Send {@link SUBMIT_KEY} after the text. Default true. `false` leaves the
   * assignment in the CLI's input field for a human to edit and send.
   */
  autoSubmit?: boolean
  /** Delay before the submitting Enter. See {@link SUBMIT_KEY}. */
  submitDelayMs?: number
  /**
   * How long to watch for a buffer reaction after each Enter before retrying.
   * Grows with each failed attempt (`watchMs * (attempt + 1)`).
   */
  submitWatchMs?: number
  /**
   * Max Enter presses including the first. Whether a retry fires depends on
   * {@link submitAcceptance} — see the heuristic on
   * {@link seedWithReadyHandshake}.
   */
  submitRetries?: number
  /**
   * What counts as "the Enter was accepted".
   *
   * - `'buffer-change'` (default): any buffer mutation inside the watch window
   *   stops further Enters. Correct for CLIs that stay quiet after swallowing
   *   a keypress and echo/render once they accept one.
   * - `'sustained-activity'`: only *ongoing* output counts. This exists for
   *   cursor-agent, measured against the real CLI: an Enter it swallows still
   *   produces one redraw burst (its "[Pasted text …]" chip) and then silence,
   *   so a mere buffer change proves nothing — while an accepted Enter starts
   *   a turn whose spinner streams output for seconds. The mode also changes
   *   how the handshake writes: the text goes out exactly once (the TUI
   *   freezes >1s while digesting a multi-KB paste, and a "no reaction"
   *   rewrite would put a second copy of the assignment into the composer),
   *   and every Enter waits for the TUI to be settled first (an Enter pressed
   *   into the digestion freeze or into a running turn was observed to queue
   *   the composer content as an extra follow-up turn).
   */
  submitAcceptance?: SubmitAcceptance
  /** `'sustained-activity'` only: quiet ms that count as settled. */
  settleIdleMs?: number
  /** `'sustained-activity'` only: cap on waiting for a settle. */
  settleTimeoutMs?: number
}

/**
 * Wait until output that differs from `baseline` has appeared AND the buffer
 * has since been quiet for `idleMs` — the moment a redraw-after-input TUI is
 * provably thawed and settled. Bounded by `timeoutMs`: on timeout the caller
 * proceeds anyway, so a CLI that never echoes cannot stall the seed.
 * Returns false only when the process died.
 */
async function waitForSettled(
  getSnapshot: () => InteractiveSnapshot,
  baseline: string,
  idleMs: number,
  timeoutMs: number,
  pollMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  let prev = getSnapshot().buffer
  let changed = prev !== baseline
  let lastChange = Date.now()
  while (Date.now() < deadline) {
    const snap = getSnapshot()
    if (!snap.alive) return false
    if (snap.buffer !== prev) {
      prev = snap.buffer
      changed = true
      lastChange = Date.now()
    } else if (changed && Date.now() - lastChange >= idleMs) {
      return true
    }
    await sleep(pollMs)
  }
  return true
}

/**
 * Wait for CLI readiness, write the prompt with bounded retries, then submit.
 *
 * A text retry is only needed when the PTY stays completely unchanged.
 * Interactive CLIs normally echo or render immediately after accepting the
 * prompt; sending again after that creates duplicate turns or queued input.
 * (`'sustained-activity'` opts out of text retries entirely — see below.)
 *
 * The text and the Enter are two writes on purpose — see {@link SUBMIT_KEY}.
 * Enter itself is also verified: after each {@link SUBMIT_KEY}, we watch the
 * buffer, bounded by {@link SeedWithReadyOptions.submitRetries} with a growing
 * watch window. What stops the retries depends on
 * {@link SeedWithReadyOptions.submitAcceptance}:
 *
 * - `'buffer-change'` (default) stops on any buffer mutation. That prefers a
 *   missed resubmit over a double turn and is right for CLIs that stay quiet
 *   after swallowing a keypress.
 * - `'sustained-activity'` was built from measuring cursor-agent, which
 *   disproved the default's assumption twice over: its TUI freezes while
 *   digesting a multi-KB paste (so "no reaction" does not mean the text was
 *   lost — never rewrite it), and a swallowed Enter still triggers a visible
 *   redraw (so "any change" does not mean the Enter landed). What separates
 *   the two outcomes reliably is *duration*: an accepted Enter starts a turn
 *   that streams spinner/response output for seconds, a swallow is one short
 *   burst followed by silence. Each Enter is therefore pressed only into a
 *   settled TUI, and only sustained output stops the bounded retries.
 */
export async function seedWithReadyHandshake(
  write: (text: string) => void,
  getSnapshot: () => InteractiveSnapshot,
  prompt: string,
  options: SeedWithReadyOptions = {}
): Promise<boolean> {
  const ready = await waitForInteractiveReady(getSnapshot, options.ready)
  if (!ready) return false
  const maxAttempts = options.maxAttempts ?? 3
  const retryDelayMs = options.retryDelayMs ?? 600
  const acceptancePollMs = options.acceptancePollMs ?? 50
  const autoSubmit = options.autoSubmit ?? true
  const submitDelayMs = options.submitDelayMs ?? DEFAULT_SUBMIT_DELAY_MS
  const submitWatchMs = options.submitWatchMs ?? DEFAULT_SUBMIT_WATCH_MS
  const submitRetries = options.submitRetries ?? DEFAULT_SUBMIT_RETRIES
  const submitAcceptance = options.submitAcceptance ?? 'buffer-change'
  const settleIdleMs = options.settleIdleMs ?? DEFAULT_SETTLE_IDLE_MS
  const settleTimeoutMs = options.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS
  // A caller that already terminated its prompt must not produce two returns.
  const text = prompt.endsWith(SUBMIT_KEY) ? prompt.slice(0, -1) : prompt

  // 'sustained-activity' writes the text exactly once: its TUI freezes for
  // longer than any sane retryDelayMs while digesting a multi-KB paste, and a
  // rewrite would land a second copy of the whole assignment in the composer.
  const textAttempts = submitAcceptance === 'sustained-activity' ? 1 : maxAttempts
  let textBaseline = ''

  for (let attempt = 0; attempt < textAttempts; attempt++) {
    const before = getSnapshot()
    if (!before.alive) return false
    textBaseline = before.buffer
    write(text)
    if (attempt === textAttempts - 1) break

    let reacted = false
    const deadline = Date.now() + retryDelayMs
    while (Date.now() < deadline) {
      await sleep(Math.min(acceptancePollMs, Math.max(1, deadline - Date.now())))
      const after = getSnapshot()
      if (!after.alive) return false
      if (after.buffer !== before.buffer) {
        reacted = true
        break
      }
    }
    if (reacted) break
  }

  if (!autoSubmit) return true
  await sleep(submitDelayMs)
  if (!getSnapshot().alive) return false

  if (submitAcceptance === 'sustained-activity') {
    return submitWithSustainedActivity(write, getSnapshot, textBaseline, {
      submitRetries,
      submitWatchMs,
      settleIdleMs,
      settleTimeoutMs,
      pollMs: acceptancePollMs
    })
  }

  for (let attempt = 0; attempt < submitRetries; attempt++) {
    const before = getSnapshot()
    if (!before.alive) return false
    // Separate write from the prompt text — never glue Enter onto the paste.
    write(SUBMIT_KEY)
    if (attempt === submitRetries - 1) break

    let reacted = false
    // Growing window: a still-digesting multi-KB paste needs more time later.
    const watchMs = submitWatchMs * (attempt + 1)
    const deadline = Date.now() + watchMs
    while (Date.now() < deadline) {
      await sleep(Math.min(acceptancePollMs, Math.max(1, deadline - Date.now())))
      const after = getSnapshot()
      if (!after.alive) return false
      if (after.buffer !== before.buffer) {
        reacted = true
        break
      }
    }
    if (reacted) break
  }

  return true
}

/**
 * The `'sustained-activity'` submit sequence. Every number in here comes from
 * probing the real cursor-agent (v2026.08.11) over a PTY:
 *
 * 1. Never press Enter into a busy TUI. During the paste-digestion freeze a
 *    queued Enter is either folded into the paste as a newline or applied
 *    late; during a running turn it queues the composer content as an EXTRA
 *    follow-up turn. Both were observed. So each press waits for the buffer
 *    to settle (`settleIdleMs` of quiet after the last change, capped by
 *    `settleTimeoutMs`) — for the first Enter that means the paste echo has
 *    appeared and stopped, replacing any fixed delay.
 * 2. Accepted = sustained output. A submitted prompt starts a turn whose
 *    spinner streams for seconds; a swallowed Enter produces one redraw burst
 *    and then silence. Activity spanning at least half the base watch window
 *    stops the retries; a burst that dies down does not.
 * 3. Bounded. At most `submitRetries` presses, with growing watch windows —
 *    and a retry only ever fires after observed silence, the strongest
 *    available "nothing is running" signal.
 */
async function submitWithSustainedActivity(
  write: (text: string) => void,
  getSnapshot: () => InteractiveSnapshot,
  textBaseline: string,
  opts: {
    submitRetries: number
    submitWatchMs: number
    settleIdleMs: number
    settleTimeoutMs: number
    pollMs: number
  }
): Promise<boolean> {
  const sustainMs = Math.max(1, Math.floor(opts.submitWatchMs / 2))
  let settleBaseline = textBaseline

  for (let attempt = 0; attempt < opts.submitRetries; attempt++) {
    const settled = await waitForSettled(
      getSnapshot,
      settleBaseline,
      opts.settleIdleMs,
      opts.settleTimeoutMs,
      opts.pollMs
    )
    if (!settled) return false
    const before = getSnapshot()
    if (!before.alive) return false
    write(SUBMIT_KEY)
    if (attempt === opts.submitRetries - 1) break

    const watchMs = opts.submitWatchMs * (attempt + 1)
    const deadline = Date.now() + watchMs
    let prev = before.buffer
    let firstChangeAt: number | undefined
    let accepted = false
    while (Date.now() < deadline) {
      await sleep(Math.min(opts.pollMs, Math.max(1, deadline - Date.now())))
      const after = getSnapshot()
      if (!after.alive) return false
      if (after.buffer !== prev) {
        prev = after.buffer
        const now = Date.now()
        if (firstChangeAt === undefined) firstChangeAt = now
        if (now - firstChangeAt >= sustainMs) {
          accepted = true
          break
        }
      }
    }
    if (accepted) break
    // Quiet since the last observed frame — the settle gate of the retry.
    settleBaseline = prev
  }

  return true
}

/**
 * Map a provider's optional `seed` block onto {@link SeedWithReadyOptions}.
 * Absent fields stay absent so handshake defaults apply.
 */
export function seedOptionsFromProvider(
  seed:
    | {
        submitDelayMs?: number
        submitRetries?: number
        submitWatchMs?: number
        submitAcceptance?: SubmitAcceptance
      }
    | undefined
): SeedWithReadyOptions {
  if (!seed) return {}
  return {
    ...(seed.submitDelayMs !== undefined ? { submitDelayMs: seed.submitDelayMs } : {}),
    ...(seed.submitRetries !== undefined ? { submitRetries: seed.submitRetries } : {}),
    ...(seed.submitWatchMs !== undefined ? { submitWatchMs: seed.submitWatchMs } : {}),
    ...(seed.submitAcceptance !== undefined ? { submitAcceptance: seed.submitAcceptance } : {})
  }
}
