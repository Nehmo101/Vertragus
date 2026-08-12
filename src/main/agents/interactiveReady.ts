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

/**
 * DECSET 2004 — how a CLI announces "send me pastes bracketed". A TUI emits
 * the enable when it takes the keyboard and the disable when it hands it back
 * (shelling out, exiting), so the last one in the scrollback is the current
 * state. See {@link bracketedPasteActive}.
 */
export const BRACKETED_PASTE_ON = '\u001b[?2004h'
export const BRACKETED_PASTE_OFF = '\u001b[?2004l'

/** The markers a terminal wraps pasted text in once DECSET 2004 is on. */
export const PASTE_BEGIN = '\u001b[200~'
export const PASTE_END = '\u001b[201~'

/**
 * True when the CLI's most recent DECSET 2004 was an enable — i.e. it is
 * asking for real pastes and will read anything between {@link PASTE_BEGIN}
 * and {@link PASTE_END} as literal text instead of as keystrokes.
 *
 * Read off the scrollback, which is a bounded ring: an agent that has printed
 * more than `SCROLLBACK_LIMIT` since booting can have its announcement evicted,
 * and a later seed then falls back to the raw write. That is today's behaviour,
 * not a new failure mode — and a TUI re-announces whenever it retakes the
 * keyboard.
 */
export function bracketedPasteActive(buffer: string): boolean {
  const on = buffer.lastIndexOf(BRACKETED_PASTE_ON)
  if (on < 0) return false
  return buffer.lastIndexOf(BRACKETED_PASTE_OFF) < on
}

/**
 * Line breaks as `\n`, never `\r` — for every seed write, framed or raw.
 *
 * A carriage return IS the submitting keystroke ({@link SUBMIT_KEY}), so one
 * sitting inside the assignment is an Enter nobody meant to press: enough to
 * submit a fragment and strand the rest in the composer. A role prompt edited
 * on Windows arrives CRLF, which makes this the cheapest of the ways this seed
 * could lose text.
 */
export function seedNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

/**
 * The body of a bracketed paste: {@link seedNewlines} minus any paste marker
 * the text itself carries. A prompt quoting terminal escapes would otherwise
 * close the bracket early and turn its own remainder back into keystrokes.
 */
export function pasteBody(text: string): string {
  // eslint-disable-next-line no-control-regex
  return seedNewlines(text.replace(/\u001b\[20[01]~/g, ''))
}

/** {@link pasteBody} between the paste markers. */
export function bracketPaste(text: string): string {
  return `${PASTE_BEGIN}${pasteBody(text)}${PASTE_END}`
}

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

/** See {@link SeedWithReadyOptions.bracketedPaste}. */
export type BracketedPasteMode = 'auto' | 'never'

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
   * - `'sustained-activity'` (default): only *ongoing* output counts. Built
   *   from measuring cursor-agent, then made the default when Claude Code
   *   failed the same way live: an Enter these composer TUIs swallow still
   *   produces one redraw burst (the "[Pasted text …]" chip) and then
   *   silence, so a mere buffer change proves nothing — while an accepted
   *   Enter starts a turn whose spinner streams output for seconds. The mode
   *   also changes how the handshake writes: the text is settle-gated and
   *   goes out exactly once (the TUI freezes >1s while digesting a multi-KB
   *   paste, and a "no reaction" rewrite would land a second copy of the
   *   assignment in the composer), and every Enter waits for the TUI to be
   *   settled first (an Enter pressed into the digestion freeze or into a
   *   running turn was observed to queue the composer content as an extra
   *   follow-up turn).
   * - `'buffer-change'`: any buffer mutation inside the watch window stops
   *   further Enters, and the text write is retried while the buffer stays
   *   still. Only correct for a CLI that stays quiet after swallowing a
   *   keypress — an assumption cursor-agent and Claude Code both disproved,
   *   so this survives as an opt-out for plain REPL-style providers, not as
   *   the default.
   */
  submitAcceptance?: SubmitAcceptance
  /** `'sustained-activity'` only: quiet ms that count as settled. */
  settleIdleMs?: number
  /** `'sustained-activity'` only: cap on waiting for a settle. */
  settleTimeoutMs?: number
  /**
   * Whether the assignment may travel as a real bracketed paste.
   *
   * - `'auto'` (default): frame it in {@link PASTE_BEGIN}/{@link PASTE_END}
   *   whenever the CLI has announced DECSET 2004 — see
   *   {@link bracketedPasteActive}. Nothing else changes for a CLI that never
   *   announces it: the raw write is still the fallback.
   * - `'never'`: always write the raw text. The opt-out for a CLI that turns
   *   bracketed paste on but mishandles the markers.
   */
  bracketedPaste?: BracketedPasteMode
  /**
   * Called once with the verdict on the submitting Enter: `true` when the CLI
   * was observed reacting the way an accepted submit looks (see
   * {@link submitAcceptance}), `false` when every bounded retry was spent
   * without that reaction. Not called when `autoSubmit` is off.
   *
   * The handshake's own return value stays "the text was delivered to a live
   * CLI" — an unconfirmed Enter is a warning, not a reason to tear down an
   * agent that may well have received its task.
   */
  onSubmitted?: (confirmed: boolean) => void
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
 * The text and the Enter are two writes on purpose — see {@link SUBMIT_KEY}.
 * Enter itself is also verified: after each {@link SUBMIT_KEY}, we watch the
 * buffer, bounded by {@link SeedWithReadyOptions.submitRetries} with a growing
 * watch window. What stops the retries depends on
 * {@link SeedWithReadyOptions.submitAcceptance}:
 *
 * - `'sustained-activity'` (default) was built from measuring cursor-agent,
 *   which disproved the old heuristic's assumption twice over: its TUI
 *   freezes while digesting a multi-KB paste (so "no reaction" does not mean
 *   the text was lost — never rewrite it), and a swallowed Enter still
 *   triggers a visible redraw (so "any change" does not mean the Enter
 *   landed). Claude Code then failed the same way live — of two identical
 *   seeds started seconds apart, one landed and one left an empty composer
 *   while the old heuristic reported both as accepted — so the measured mode
 *   became the default for every provider. What separates a swallow from an
 *   accept reliably is *duration*: an accepted Enter starts a turn that
 *   streams spinner/response output for seconds, a swallow is one short
 *   burst followed by silence. The text is written once, into a settled TUI;
 *   each Enter is pressed only into a settled TUI; and only sustained output
 *   stops the bounded retries.
 * - `'buffer-change'` stops on any buffer mutation and retries the text while
 *   the buffer stays still. It survives as an opt-out for plain REPL-style
 *   providers whose only redraw IS the acceptance echo.
 *
 * **How the text travels.** Everything above tunes *timing*, and timing was
 * only ever half the problem: a raw multi-KB write is not a paste, it is a
 * stream of keystrokes. The PTY hands it to the CLI in read-sized chunks, so
 * every `\n` in a role prompt is a coin flip — inside a chunk the CLI's own
 * paste heuristic may absorb it, on a chunk boundary it arrives alone and is
 * decoded as Enter, submitting half an assignment (or, when it lands last,
 * consuming the real Enter's job). Terminals solved this with DECSET 2004: a
 * TUI that wants pastes says so, and the terminal frames them. So does
 * Vertragus now — when the CLI has announced bracketed paste, the assignment
 * goes out framed by {@link PASTE_BEGIN}/{@link PASTE_END} and no byte inside
 * it can be read as a key, whatever the chunking. The submitting Enter stays
 * a separate, unframed write, which is exactly what makes it unambiguous.
 * Providers that never announce DECSET 2004 keep the raw write.
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
  const submitAcceptance = options.submitAcceptance ?? 'sustained-activity'
  const settleIdleMs = options.settleIdleMs ?? DEFAULT_SETTLE_IDLE_MS
  const settleTimeoutMs = options.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS
  const bracketedPaste = options.bracketedPaste ?? 'auto'
  // A caller that already terminated its prompt must not produce two returns.
  const text = prompt.endsWith(SUBMIT_KEY) ? prompt.slice(0, -1) : prompt

  // 'sustained-activity' writes the text exactly once: its TUI freezes for
  // longer than any sane retryDelayMs while digesting a multi-KB paste, and a
  // rewrite would land a second copy of the whole assignment in the composer.
  const textAttempts = submitAcceptance === 'sustained-activity' ? 1 : maxAttempts
  let textBaseline = ''

  // …and only into a quiet TUI. The live Claude Code failure was the paste
  // racing the CLI's own boot rendering: of two identical seeds started
  // seconds apart, the busy one lost the entire text. The ready check can
  // fall through on its timeout while a TUI is still painting, so the paste
  // gets the same settle gate as every Enter — bounded by settleTimeoutMs,
  // so a CLI that never goes quiet still gets seeded.
  if (submitAcceptance === 'sustained-activity') {
    const settled = await waitForSettled(
      getSnapshot,
      '',
      settleIdleMs,
      settleTimeoutMs,
      acceptancePollMs
    )
    if (!settled) return false
  }

  // Decided here and not earlier: a TUI announces DECSET 2004 when it takes
  // the keyboard, which is after the boot output the ready/settle gates above
  // were waiting through. Asked once, so every retry writes the same bytes.
  const payload =
    bracketedPaste === 'auto' && bracketedPasteActive(getSnapshot().buffer)
      ? bracketPaste(text)
      : seedNewlines(text)

  for (let attempt = 0; attempt < textAttempts; attempt++) {
    const before = getSnapshot()
    if (!before.alive) return false
    textBaseline = before.buffer
    write(payload)
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
    const outcome = await submitWithSustainedActivity(write, getSnapshot, textBaseline, {
      submitRetries,
      submitWatchMs,
      settleIdleMs,
      settleTimeoutMs,
      pollMs: acceptancePollMs
    })
    if (!outcome.alive) return false
    options.onSubmitted?.(outcome.confirmed)
    return true
  }

  let confirmed = false
  for (let attempt = 0; attempt < submitRetries; attempt++) {
    const before = getSnapshot()
    if (!before.alive) return false
    // Separate write from the prompt text — never glue Enter onto the paste.
    write(SUBMIT_KEY)

    // Growing window: a still-digesting multi-KB paste needs more time later.
    // The last attempt is watched too — not to decide on another retry, but so
    // the caller is told the truth about whether the Enter ever landed.
    const watchMs = submitWatchMs * (attempt + 1)
    const deadline = Date.now() + watchMs
    while (Date.now() < deadline) {
      await sleep(Math.min(acceptancePollMs, Math.max(1, deadline - Date.now())))
      const after = getSnapshot()
      if (!after.alive) return false
      if (after.buffer !== before.buffer) {
        confirmed = true
        break
      }
    }
    if (confirmed) break
  }

  options.onSubmitted?.(confirmed)
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
 *    available "nothing is running" signal. The final press is watched like
 *    every other one; it just has no retry left, so its only product is the
 *    `confirmed` verdict the caller reports.
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
): Promise<{ alive: boolean; confirmed: boolean }> {
  const dead = { alive: false, confirmed: false }
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
    if (!settled) return dead
    const before = getSnapshot()
    if (!before.alive) return dead
    write(SUBMIT_KEY)

    const watchMs = opts.submitWatchMs * (attempt + 1)
    const deadline = Date.now() + watchMs
    let prev = before.buffer
    let firstChangeAt: number | undefined
    let accepted = false
    while (Date.now() < deadline) {
      await sleep(Math.min(opts.pollMs, Math.max(1, deadline - Date.now())))
      const after = getSnapshot()
      if (!after.alive) return dead
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
    if (accepted) return { alive: true, confirmed: true }
    // Quiet since the last observed frame — the settle gate of the retry.
    settleBaseline = prev
  }

  return { alive: true, confirmed: false }
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
        bracketedPaste?: BracketedPasteMode
      }
    | undefined
): SeedWithReadyOptions {
  if (!seed) return {}
  return {
    ...(seed.submitDelayMs !== undefined ? { submitDelayMs: seed.submitDelayMs } : {}),
    ...(seed.submitRetries !== undefined ? { submitRetries: seed.submitRetries } : {}),
    ...(seed.submitWatchMs !== undefined ? { submitWatchMs: seed.submitWatchMs } : {}),
    ...(seed.submitAcceptance !== undefined ? { submitAcceptance: seed.submitAcceptance } : {}),
    ...(seed.bracketedPaste !== undefined ? { bracketedPaste: seed.bracketedPaste } : {})
  }
}
