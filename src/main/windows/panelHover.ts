/**
 * "Is the mouse over the panel?" — answered by the main process, because CSS
 * cannot answer it here.
 *
 * The panel has no title bar, so its whole surface is `-webkit-app-region: drag`
 * (see panel.css). On Windows a drag region is reported to the OS as window
 * caption: the compositor handles the pointer there and Chromium never sees a
 * mouse event for it. The measurable consequence — verified on the real app —
 * is that `.panel:hover` is TRUE while the cursor sits on a button (a no-drag
 * island) and FALSE two pixels next to it, over the very same panel. Which is
 * exactly the bug report: "the sidebar only becomes opaque over the
 * orchestrator's name".
 *
 * No CSS fixes that, so the cursor is tracked from the outside: while the panel
 * is visible, poll `screen.getCursorScreenPoint()` and compare it against the
 * window bounds. Only state CHANGES are pushed to the renderer, which turns them
 * into the `is-pointer-over` root class. Whole-surface dragging stays intact.
 *
 * The poll is a deliberate trade: 8 Hz of two integer reads is far cheaper than
 * losing the app's defining interaction, and it stops dead the moment the panel
 * is hidden or gone. Everything below is injectable (fake screen, fake timers)
 * so the state machine is unit-tested without an Electron runtime.
 */
import { screen, type BrowserWindow } from 'electron'

/** Main → panel push. Duplicated in preload; panelHover.test.ts asserts parity. */
export const PANEL_POINTER_CHANNEL = 'panel:pointer'

/** Fast enough to feel like hover, slow enough to be free. */
export const PANEL_HOVER_POLL_MS = 125

/**
 * Bounds are inclusive by a few pixels: the panel sits at a screen edge, and a
 * cursor resting exactly on the border should read as "inside" rather than
 * flicker the whole sheet between 0.6 and 0.97.
 */
export const PANEL_HOVER_TOLERANCE = 4

export interface PointerPoint {
  x: number
  y: number
}

export interface PanelHoverBounds {
  x: number
  y: number
  width: number
  height: number
}

/** Payload of {@link PANEL_POINTER_CHANNEL}. */
export interface PanelPointerEvent {
  inside: boolean
}

/** Point-in-rectangle with the edge tolerance above. */
export function isPointerInside(
  point: PointerPoint,
  bounds: PanelHoverBounds,
  tolerance: number = PANEL_HOVER_TOLERANCE
): boolean {
  return (
    point.x >= bounds.x - tolerance &&
    point.x <= bounds.x + bounds.width + tolerance &&
    point.y >= bounds.y - tolerance &&
    point.y <= bounds.y + bounds.height + tolerance
  )
}

/** The slice of BrowserWindow the tracker uses. */
export interface PanelHoverWindow {
  isDestroyed(): boolean
  isVisible(): boolean
  getBounds(): PanelHoverBounds
  send(channel: string, payload: PanelPointerEvent): void
}

export interface PanelHoverDeps {
  window: PanelHoverWindow
  cursorPoint(): PointerPoint
  setInterval(handler: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
  intervalMs?: number
  tolerance?: number
}

export interface PanelHoverTracker {
  /** Begin polling. Pushes the current state immediately; idempotent. */
  start(): void
  /** Stop polling and forget the last state; idempotent. */
  stop(): void
  /** One poll step — the test seam that needs no timer at all. */
  tick(): void
  /** Re-push the current state, e.g. after the renderer reloaded. */
  resync(): void
  isRunning(): boolean
  /** Last state pushed to the renderer, or undefined before the first push. */
  lastInside(): boolean | undefined
}

export function createPanelHoverTracker(deps: PanelHoverDeps): PanelHoverTracker {
  const intervalMs = deps.intervalMs ?? PANEL_HOVER_POLL_MS
  const tolerance = deps.tolerance ?? PANEL_HOVER_TOLERANCE
  let handle: unknown
  let last: boolean | undefined

  function stop(): void {
    if (handle !== undefined) {
      deps.clearInterval(handle)
      handle = undefined
    }
    // Forgotten, not remembered: the next start() must push the truth even if
    // the pointer never moved while the panel was hidden.
    last = undefined
  }

  /** Only changes travel — 8 identical messages per second would be noise. */
  function push(inside: boolean): void {
    if (inside === last) return
    last = inside
    deps.window.send(PANEL_POINTER_CHANNEL, { inside })
  }

  function tick(): void {
    const win = deps.window
    if (win.isDestroyed()) {
      stop()
      return
    }
    // Hidden means "not under the pointer", whatever the stale bounds say.
    if (!win.isVisible()) {
      push(false)
      return
    }
    let inside: boolean
    try {
      inside = isPointerInside(deps.cursorPoint(), win.getBounds(), tolerance)
    } catch {
      // A window torn down between the checks above and this call: stop rather
      // than throw out of a timer nobody catches.
      stop()
      return
    }
    push(inside)
  }

  return {
    start() {
      if (handle !== undefined || deps.window.isDestroyed()) return
      handle = deps.setInterval(tick, intervalMs)
      // A Node interval must never be the reason the process stays alive.
      ;(handle as { unref?: () => void } | undefined)?.unref?.()
      tick()
    },
    stop,
    tick,
    resync() {
      last = undefined
      if (handle !== undefined) tick()
    },
    isRunning: () => handle !== undefined,
    lastInside: () => last
  }
}

/**
 * Production wiring: bind a tracker to the real panel window and to its
 * lifecycle. Polling runs exactly while the window is shown.
 */
export function attachPanelHoverTracking(win: BrowserWindow): PanelHoverTracker {
  const tracker = createPanelHoverTracker({
    window: {
      isDestroyed: () => win.isDestroyed(),
      isVisible: () => win.isVisible(),
      getBounds: () => win.getBounds(),
      send: (channel, payload) => {
        if (win.isDestroyed() || win.webContents.isDestroyed()) return
        win.webContents.send(channel, payload)
      }
    },
    cursorPoint: () => screen.getCursorScreenPoint(),
    setInterval: (handler, ms) => setInterval(handler, ms),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>)
  })

  win.on('show', () => tracker.start())
  win.on('hide', () => tracker.stop())
  win.on('closed', () => tracker.stop())
  // A reload drops the root class, so the state has to be pushed again.
  win.webContents.on('did-finish-load', () => tracker.resync())
  if (win.isVisible()) tracker.start()
  return tracker
}
