/**
 * The one capture path behind every `VERTRAGUS_*_SCREENSHOT` hook.
 *
 * Five windows used to carry a byte-identical copy of "wait for
 * did-finish-load, sleep, capturePage, exit". That copy assumed a capture
 * either works on the first try or is broken — which is true on Windows and
 * macOS and false under Xvfb: a headless X server has no compositor, the viz
 * process brings its frame sink up asynchronously, and a copy request that
 * arrives too early is answered with `UnknownVizError`. CI proved it: the same
 * commit captured fine at 10:16 and failed at 11:39 on the Linux runner.
 *
 * So the capture is retried, and it is preceded by two conditions that must
 * hold before a frame can exist at all:
 *
 *  - the window is shown (an unmapped window has no surface to copy), and
 *  - the renderer has actually painted something into `#root`.
 *
 * The second one is not just a precondition, it is the assertion the smoke
 * exists for: a CSP violation, a preload that throws or a bundle that fails to
 * mount all end in an empty `#root`, and that now fails loudly with its own
 * message instead of hiding inside a suspiciously small PNG.
 */
import { writeFile as writeFileFs } from 'node:fs/promises'
import { app } from 'electron'

/** Capture attempts before the hook gives up. */
export const CAPTURE_ATTEMPTS = 8

/** Pause between attempts — long enough for the viz process to come up. */
export const CAPTURE_RETRY_MS = 500

/** The renderer gets this many polls to mount something into `#root`. */
export const PAINT_ATTEMPTS = 20

/** Pause between paint polls. */
export const PAINT_POLL_MS = 250

/** Reads the mounted node count; anything falsy means "still a white screen". */
export const PAINTED_PROBE = 'document.getElementById("root")?.childElementCount ?? 0'

/**
 * The slice of `BrowserWindow` the capture needs. Structural on purpose: the
 * unit tests drive this with a fake instead of booting Electron.
 */
export interface SmokeCaptureWindow {
  isDestroyed(): boolean
  isVisible(): boolean
  show(): void
  webContents: {
    once(event: 'did-finish-load', listener: () => void): unknown
    capturePage(): Promise<{ isEmpty(): boolean; toPNG(): Buffer }>
    executeJavaScript(code: string): Promise<unknown>
  }
}

export interface CaptureOptions {
  /** Attempts for the capture itself. */
  attempts?: number
  /** Pause between capture attempts. */
  retryMs?: number
  /** Polls for a painted renderer. */
  paintAttempts?: number
  /** Pause between paint polls. */
  paintPollMs?: number
  writeFile?: (path: string, data: Buffer) => Promise<void>
  wait?: (ms: number) => Promise<void>
  log?: (message: string, ...rest: unknown[]) => void
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Show the window if it is hidden. Every glass window starts `show: false` and
 * is shown on `ready-to-show`; when the capture wins that race the window is
 * still unmapped, and on Linux an unmapped window has nothing to copy.
 */
function ensureVisible(win: SmokeCaptureWindow): void {
  if (!win.isVisible()) win.show()
}

/**
 * Wait until the renderer has mounted into `#root`. Returns false if it never
 * does — a white screen, which is exactly what this smoke is here to catch.
 */
async function waitForPaint(
  win: SmokeCaptureWindow,
  label: string,
  attempts: number,
  pollMs: number,
  wait: (ms: number) => Promise<void>,
  log: (message: string, ...rest: unknown[]) => void
): Promise<boolean> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (win.isDestroyed()) return false
    try {
      const mounted = await win.webContents.executeJavaScript(PAINTED_PROBE)
      if (typeof mounted === 'number' && mounted > 0) return true
    } catch (error) {
      log(`[smoke] ${label}: paint probe failed:`, error)
    }
    if (attempt < attempts) await wait(pollMs)
  }
  log(`[smoke] ${label}: #root stayed empty — the renderer drew nothing.`)
  return false
}

/**
 * Capture `win` into `target`. Returns whether a usable PNG was written; the
 * caller turns that into the process exit code.
 */
export async function captureWindowToFile(
  win: SmokeCaptureWindow,
  target: string,
  label: string,
  options: CaptureOptions = {}
): Promise<boolean> {
  const {
    attempts = CAPTURE_ATTEMPTS,
    retryMs = CAPTURE_RETRY_MS,
    paintAttempts = PAINT_ATTEMPTS,
    paintPollMs = PAINT_POLL_MS,
    writeFile = writeFileFs,
    wait = sleep,
    log = console.error
  } = options

  if (win.isDestroyed()) {
    // Developer-facing CI log, not UI copy — English like the rest of stderr.
    log(`[smoke] ${label}: window is already destroyed.`)
    return false
  }
  ensureVisible(win)

  if (!(await waitForPaint(win, label, paintAttempts, paintPollMs, wait, log))) return false

  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (win.isDestroyed()) {
      log(`[smoke] ${label}: window disappeared during capture.`)
      return false
    }
    ensureVisible(win)
    try {
      const image = await win.webContents.capturePage()
      // A capture that "succeeded" with nothing in it is a failed capture; the
      // viz process reports that this way instead of rejecting.
      if (image.isEmpty()) throw new Error('capturePage returned an empty image.')
      await writeFile(target, image.toPNG())
      return true
    } catch (error) {
      lastError = error
      log(`[smoke] ${label}: capture ${attempt}/${attempts} failed:`, error)
      if (attempt < attempts) await wait(retryMs)
    }
  }
  log(`[smoke] ${label}: no capture after ${attempts} attempts.`, lastError)
  return false
}

/**
 * Arm the env-gated capture hook for one window: `<envVar>=<png>` boots it,
 * captures it once the page has loaded and exits. A no-op without the env, so
 * this is inert in every normal run.
 */
export function armWindowCapture(
  win: SmokeCaptureWindow,
  envVar: string,
  label: string,
  delayMs: number,
  options: CaptureOptions = {}
): void {
  const target = process.env[envVar]
  if (!target) return
  win.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      void captureWindowToFile(win, target, label, options).then((ok) => app.exit(ok ? 0 : 1))
    }, delayMs)
  })
}
