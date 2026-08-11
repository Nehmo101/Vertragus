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

/** Max Enter presses including the first (retries only when the buffer stays still). */
export const DEFAULT_SUBMIT_RETRIES = 3

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
   * Max Enter presses including the first. Retries only fire when the PTY
   * buffer is unchanged after the previous Enter — see the heuristic on
   * {@link seedWithReadyHandshake}.
   */
  submitRetries?: number
}

/**
 * Wait for CLI readiness, write the prompt with bounded retries, then submit.
 *
 * A retry is only needed when the PTY stays completely unchanged. Interactive
 * CLIs normally echo or render immediately after accepting the prompt; sending
 * again after that creates duplicate turns or queued input.
 *
 * The text and the Enter are two writes on purpose — see {@link SUBMIT_KEY}.
 * Enter itself is also verified: after each {@link SUBMIT_KEY}, we watch the
 * buffer. Unchanged → the keypress was likely swallowed as a paste newline
 * (Cursor with a multi-KB system prompt is the known case) and we press again,
 * bounded by {@link SeedWithReadyOptions.submitRetries}, with a growing watch
 * window. Any buffer mutation — including a lone `\r` echo — stops retries.
 * That prefers a missed resubmit over a double turn: a CLI that already
 * accepted Enter almost always emits *something* within the watch window, while
 * a silent swallow leaves the buffer byte-identical.
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
  // A caller that already terminated its prompt must not produce two returns.
  const text = prompt.endsWith(SUBMIT_KEY) ? prompt.slice(0, -1) : prompt

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const before = getSnapshot()
    if (!before.alive) return false
    write(text)
    if (attempt === maxAttempts - 1) break

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
 * Map a provider's optional `seed` block onto {@link SeedWithReadyOptions}.
 * Absent fields stay absent so handshake defaults apply.
 */
export function seedOptionsFromProvider(
  seed: { submitDelayMs?: number; submitRetries?: number; submitWatchMs?: number } | undefined
): SeedWithReadyOptions {
  if (!seed) return {}
  return {
    ...(seed.submitDelayMs !== undefined ? { submitDelayMs: seed.submitDelayMs } : {}),
    ...(seed.submitRetries !== undefined ? { submitRetries: seed.submitRetries } : {}),
    ...(seed.submitWatchMs !== undefined ? { submitWatchMs: seed.submitWatchMs } : {})
  }
}
