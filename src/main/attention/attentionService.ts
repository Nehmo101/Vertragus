/**
 * Taskbar / dock attention for pending user feedback.
 *
 * Starts a single flash/bounce when the aggregated pending-feedback count
 * transitions 0 → >0 while the main window is unfocused. Stops on count===0
 * or when the window gains focus. Repeated >0 updates are idempotent.
 */
import { app } from 'electron'

/** Minimal window surface used by the service (BrowserWindow satisfies this). */
export interface AttentionWindowLike {
  isFocused(): boolean
  isDestroyed(): boolean
  flashFrame(flag: boolean): void
  on(event: 'focus' | 'closed', listener: () => void): unknown
  removeListener(event: 'focus' | 'closed', listener: () => void): unknown
}

/** Minimal macOS dock surface (app.dock satisfies this when present). */
export interface AttentionDockLike {
  bounce(type?: 'critical' | 'informational'): number
  cancelBounce(id: number): void
}

export interface InitAttentionServiceOptions {
  getMainWindow: () => AttentionWindowLike | null
  /** Defaults to process.platform; injectable for unit tests. */
  platform?: NodeJS.Platform
  /** Defaults to app.dock; injectable for unit tests. */
  dock?: AttentionDockLike | null
}

export interface AttentionState {
  initialized: boolean
  pendingCount: number
  flashing: boolean
  bounceId: number | null
}

let getMainWindow: (() => AttentionWindowLike | null) | null = null
let platform: NodeJS.Platform = process.platform
let dock: AttentionDockLike | null = null

let pendingCount = 0
let flashing = false
let bounceId: number | null = null
let initialized = false

let boundWindow: AttentionWindowLike | null = null
let focusListener: (() => void) | null = null
let closedListener: (() => void) | null = null

function normalizeCount(count: number): number {
  if (!Number.isFinite(count)) return 0
  return Math.max(0, Math.trunc(count))
}

function resolveWindow(): AttentionWindowLike | null {
  if (!getMainWindow) return null
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return null
  return win
}

function unbindWindow(): void {
  if (boundWindow && focusListener) {
    try {
      // Always detach; Electron may already mark the window destroyed on 'closed'.
      boundWindow.removeListener('focus', focusListener)
      if (closedListener) boundWindow.removeListener('closed', closedListener)
    } catch {
      // Window may already be torn down.
    }
  }
  boundWindow = null
  focusListener = null
  closedListener = null
}

function bindWindow(win: AttentionWindowLike | null): void {
  unbindWindow()
  if (!win || win.isDestroyed()) return

  boundWindow = win
  focusListener = () => {
    stopAttention()
  }
  closedListener = () => {
    unbindWindow()
  }
  win.on('focus', focusListener)
  win.on('closed', closedListener)
}

function stopAttention(): void {
  if (!flashing && bounceId === null) return

  const win = resolveWindow()
  if (win) {
    try {
      win.flashFrame(false)
    } catch {
      // Ignore flashFrame errors on a dying window.
    }
  }

  if (bounceId !== null && dock) {
    try {
      dock.cancelBounce(bounceId)
    } catch {
      // Dock may be unavailable after quit.
    }
  }

  bounceId = null
  flashing = false
}

function startAttention(): void {
  // Single blink state: never start a second competing flash/bounce.
  if (flashing) return

  const win = resolveWindow()
  if (!win) return
  if (win.isFocused()) return

  if (platform === 'darwin') {
    if (dock) {
      try {
        bounceId = dock.bounce('critical')
        flashing = true
        return
      } catch {
        bounceId = null
      }
    }
    // No dock (unusual) — fall back to flashFrame so attention is still visible.
  }

  try {
    win.flashFrame(true)
    flashing = true
  } catch {
    flashing = false
  }
}

/**
 * Wire the attention service to the main window getter.
 * Safe to call again after the window is recreated (re-binds listeners).
 */
export function initAttentionService(opts: InitAttentionServiceOptions): void {
  getMainWindow = opts.getMainWindow
  platform = opts.platform ?? process.platform
  dock = opts.dock !== undefined ? opts.dock : (app.dock ?? null)
  initialized = true

  bindWindow(resolveWindow())

  // If feedback is already pending and the window is unfocused, ensure attention is active.
  if (pendingCount > 0) {
    const win = resolveWindow()
    if (win && !win.isFocused()) startAttention()
    else stopAttention()
  } else {
    stopAttention()
  }
}

/**
 * Update the aggregated count of workspaces awaiting user feedback.
 * Only a 0 → >0 transition (while unfocused) starts attention; count===0 stops it.
 */
export function setPendingFeedbackCount(count: number): void {
  const previous = pendingCount
  const next = normalizeCount(count)
  pendingCount = next

  // Keep focus listener attached if the main window instance changed.
  const win = resolveWindow()
  if (win !== boundWindow) {
    bindWindow(win)
  }

  if (next === 0) {
    stopAttention()
    return
  }

  if (previous === 0 && next > 0) {
    startAttention()
  }
}

/** Snapshot of the state machine for unit tests. */
export function getAttentionStateForTest(): AttentionState {
  return {
    initialized,
    pendingCount,
    flashing,
    bounceId
  }
}

/** Reset module state between unit tests. */
export function resetAttentionServiceForTest(): void {
  stopAttention()
  unbindWindow()
  getMainWindow = null
  platform = process.platform
  dock = null
  pendingCount = 0
  flashing = false
  bounceId = null
  initialized = false
}
