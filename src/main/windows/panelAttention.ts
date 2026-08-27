/**
 * Native taskbar / dock attention for open human questions.
 *
 * Lifetime is the open-question set, not window focus. Electron's
 * `flashFrame(true)` (and re-arming it) is a no-op on Windows while the
 * panel is already focused — the OS stops flashing the taskbar button — so
 * this module also toggles `setOverlayIcon` on the same re-arm interval.
 * That overlay lives on the taskbar button even when the window is
 * foreground. `flashFrame` and macOS dock bounce stay as the unfocused
 * path. The panel window is the only target (`skipTaskbar: false`); CLI
 * windows are never flashed, the panel is never focused, and no OS
 * Notification is posted. Stops only when PendingQuestions.openCount hits
 * zero.
 */
import { deflateSync } from 'node:zlib'

/** How often to restart flashFrame / overlay / dock bounce while questions remain. */
export const PANEL_ATTENTION_REARM_MS = 1_200

/** Overlay badge size Windows paints on the taskbar button. */
const OVERLAY_SIZE = 16

/** The slice of BrowserWindow native attention uses. */
export interface FlashableWindow {
  isDestroyed(): boolean
  flashFrame(flag: boolean): void
  /**
   * Windows taskbar overlay. Pass `null` to clear. No-op on other platforms;
   * still called so a focused panel keeps a visible blink via the overlay.
   */
  setOverlayIcon(overlay: unknown | null, description: string): void
}

/** macOS `app.dock` — omitted on Windows/Linux. */
export interface DockBounce {
  bounce(type?: 'critical' | 'informational'): number
  cancelBounce(id: number): void
}

/** Injected NativeImage (production) or a test sentinel. */
export interface OverlayIcon {
  image: unknown
  description: () => string
}

export interface PanelAttentionDeps {
  /** The panel window. Never a CLI window. */
  window(): FlashableWindow | null
  /** macOS dock; return null on other platforms. */
  dock?(): DockBounce | null
  /** Taskbar overlay toggled on the re-arm interval (focused-window path). */
  overlay?: OverlayIcon | null
}

export interface PanelAttention {
  /** Turn native attention on iff `openCount > 0`. Idempotent. */
  sync(openCount: number): void
  /** Stop flashing and drop the re-arm timer (shutdown). */
  dispose(): void
}

export function createPanelAttention(deps: PanelAttentionDeps): PanelAttention {
  let timer: ReturnType<typeof setInterval> | undefined
  let bounceId: number | undefined
  let active = false
  /** True while the overlay is currently applied (toggles every pulse). */
  let overlayOn = false

  function applyOverlay(win: FlashableWindow, on: boolean): void {
    const overlay = deps.overlay
    if (!overlay) return
    if (on) win.setOverlayIcon(overlay.image, overlay.description())
    else win.setOverlayIcon(null, '')
  }

  function pulse(): void {
    const win = deps.window()
    if (win && !win.isDestroyed()) {
      overlayOn = !overlayOn
      // Unfocused path: restart flashFrame even if the OS cancelled it on
      // focus. Never inspect isFocused, never call focus().
      win.flashFrame(false)
      win.flashFrame(true)
      // Focused path (Windows): flashFrame is a no-op while the panel is
      // foreground — toggling the overlay still animates the taskbar icon.
      applyOverlay(win, overlayOn)
    }
    const dock = deps.dock?.()
    if (!dock) return
    if (bounceId !== undefined) dock.cancelBounce(bounceId)
    // Informational bounces once even when the app is already frontmost;
    // critical stops on activation, which is the case we must keep covering.
    bounceId = dock.bounce('informational')
  }

  function start(): void {
    if (active) return
    active = true
    pulse()
    timer = setInterval(pulse, PANEL_ATTENTION_REARM_MS)
    ;(timer as { unref?: () => void }).unref?.()
  }

  function stop(): void {
    if (timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
    const wasActive = active
    active = false
    overlayOn = false
    if (!wasActive && bounceId === undefined) return
    const win = deps.window()
    if (win && !win.isDestroyed()) {
      win.flashFrame(false)
      applyOverlay(win, false)
    }
    const dock = deps.dock?.()
    if (dock && bounceId !== undefined) {
      dock.cancelBounce(bounceId)
      bounceId = undefined
    }
  }

  return {
    sync(openCount: number) {
      if (openCount > 0) start()
      else stop()
    },
    dispose() {
      stop()
    }
  }
}

export interface ArmPanelAttentionDeps extends PanelAttentionDeps {
  openCount: () => number
  /**
   * Subscribe to workspace/question mutations. Production passes
   * `manager.onChange`, which already includes PendingQuestions.onMutate.
   */
  onChange: (listener: () => void) => () => void
}

/**
 * Drive {@link createPanelAttention} from the question registry's mutation
 * feed. Returns a disposer that unsubscribes and stops the flash.
 */
export function armPanelAttention(deps: ArmPanelAttentionDeps): () => void {
  const attention = createPanelAttention(deps)
  const sync = (): void => attention.sync(deps.openCount())
  const off = deps.onChange(sync)
  sync()
  return () => {
    off()
    attention.dispose()
  }
}

/**
 * 16×16 PNG of a bronze attention badge. Production wraps this in
 * `nativeImage.createFromBuffer`; tests only need the PNG signature.
 */
export function attentionOverlayPng(): Buffer {
  const raw = Buffer.alloc((OVERLAY_SIZE * 4 + 1) * OVERLAY_SIZE)
  const cx = (OVERLAY_SIZE - 1) / 2
  const radius = OVERLAY_SIZE / 2 - 0.5
  for (let y = 0; y < OVERLAY_SIZE; y++) {
    const row = y * (OVERLAY_SIZE * 4 + 1)
    raw[row] = 0
    for (let x = 0; x < OVERLAY_SIZE; x++) {
      const dx = x - cx
      const dy = y - cx
      const i = row + 1 + x * 4
      if (dx * dx + dy * dy <= radius * radius) {
        raw[i] = 217
        raw[i + 1] = 115
        raw[i + 2] = 92
        raw[i + 3] = 255
      }
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(OVERLAY_SIZE, 0)
  ihdr.writeUInt32BE(OVERLAY_SIZE, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

function pngChunk(type: string, data: Buffer): Buffer {
  const header = Buffer.alloc(4)
  header.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([header, body, crc])
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}
