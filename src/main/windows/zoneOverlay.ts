/**
 * The zone editor overlay — one transparent full-screen sheet per monitor.
 *
 * Zones are drawn ON the screen they will apply to, because that is the only
 * honest preview: a miniature monitor picker inside the profile editor cannot
 * show what "the right third of the second display" actually feels like. So
 * "Zonen festlegen" opens one frameless, transparent, always-on-top window per
 * display, sized to that display's WORK AREA (not its full bounds — a zone
 * under the taskbar would place windows the user cannot reach).
 *
 * Because the overlay covers everything, it is deliberately short-lived: it is
 * opened by one IPC call, it closes on save or Esc, and closing ANY of its
 * windows closes the whole session — a leftover invisible full-screen window
 * that eats every click is the worst bug this file could have.
 *
 * The window map is the authorization root for the zone IPC, exactly like the
 * CLI and editor registries: `isZoneOverlaySender` turns a webContents id into
 * one (profileId, displayId) pair, so nothing else can write a zone layout.
 */
import { BrowserWindow, screen } from 'electron'
import { glassWindowOptions, loadRoute, secureWindow } from './base'
import { armWindowCapture } from './smokeCapture'

export interface ZoneOverlaySender {
  profileId: string
  displayId: number
}

interface OverlayEntry extends ZoneOverlaySender {
  window: BrowserWindow
}

const overlays = new Map<number, OverlayEntry>()
/** True while `closeZoneOverlayWindows` runs, so 'closed' does not recurse. */
let closing = false

export function listZoneOverlayWindows(): OverlayEntry[] {
  const alive: OverlayEntry[] = []
  for (const [displayId, entry] of overlays) {
    if (entry.window.isDestroyed()) overlays.delete(displayId)
    else alive.push(entry)
  }
  return alive
}

/** The single source of truth for "is this renderer a zone overlay". */
export function isZoneOverlaySender(webContentsId: number): ZoneOverlaySender | null {
  for (const entry of listZoneOverlayWindows()) {
    if (entry.window.webContents.id === webContentsId) {
      return { profileId: entry.profileId, displayId: entry.displayId }
    }
  }
  return null
}

/** Displays currently covered by an overlay — the layout replaces exactly these. */
export function zoneOverlayDisplayIds(): number[] {
  return listZoneOverlayWindows().map((entry) => entry.displayId)
}

export interface OpenZoneOverlayOptions {
  /**
   * Renderer-side demo layout instead of the profile's zones. Only ever set by
   * the screenshot hook below; it keeps the verification run from having to
   * write a throwaway profile into the user's real store.
   */
  demo?: boolean
}

/**
 * Open the editor on every attached display. Re-opening while a session is
 * running just refocuses it — two overlay sessions would fight over the same
 * profile's layout.
 */
export function openZoneOverlayWindows(
  profileId: string,
  options: OpenZoneOverlayOptions = {}
): BrowserWindow[] {
  const open = listZoneOverlayWindows()
  if (open.length > 0) {
    open[0]!.window.focus()
    return open.map((entry) => entry.window)
  }

  const primaryId = screen.getPrimaryDisplay().id
  const created: BrowserWindow[] = []
  for (const display of screen.getAllDisplays()) {
    const { workArea } = display
    const win = new BrowserWindow({
      ...glassWindowOptions(),
      x: workArea.x,
      y: workArea.y,
      width: workArea.width,
      height: workArea.height,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      title: 'Vertragus — Zonen'
    })
    // Above the always-on-top panel: the overlay is modal in spirit.
    win.setAlwaysOnTop(true, 'screen-saver')
    secureWindow(win)
    // Safety valve: the renderer owns Esc, but a full-screen click-eater whose
    // renderer failed to boot must still be closable.
    win.webContents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') closeZoneOverlayWindows()
    })
    const query = `?profile=${encodeURIComponent(profileId)}${options.demo ? '&demo=1' : ''}`
    loadRoute(win, `/zones/${display.id}${query}`)
    win.on('ready-to-show', () => {
      win.show()
      if (display.id === primaryId) win.focus()
    })
    // One window gone = session over. Otherwise a half-closed session would
    // save a layout for some displays and silently drop the others.
    win.on('closed', () => {
      overlays.delete(display.id)
      if (!closing) closeZoneOverlayWindows()
    })
    overlays.set(display.id, { profileId, displayId: display.id, window: win })
    created.push(win)
  }
  armZoneOverlayScreenshot(created[0])
  return created
}

export function closeZoneOverlayWindows(): void {
  if (closing) return
  closing = true
  try {
    for (const entry of listZoneOverlayWindows()) {
      overlays.delete(entry.displayId)
      entry.window.close()
    }
    overlays.clear()
  } finally {
    closing = false
  }
}

/**
 * Headless verification hook, same mechanics as the profile editor's:
 * `VERTRAGUS_ZONES_SCREENSHOT=<png>` captures the overlay on the first display
 * and exits. Without `VERTRAGUS_ZONES_PROFILE` the renderer draws a demo
 * layout, so the capture shows real zone rectangles on a fresh install.
 */
function armZoneOverlayScreenshot(win: BrowserWindow | undefined, delayMs = 3_000): void {
  if (!win) return
  armWindowCapture(win, 'VERTRAGUS_ZONES_SCREENSHOT', 'zone overlay', delayMs)
}

/** Called once at boot; a no-op in every normal run. */
export function armZoneOverlaySmoke(): void {
  if (!process.env['VERTRAGUS_ZONES_SCREENSHOT']) return
  const profileId = process.env['VERTRAGUS_ZONES_PROFILE']?.trim()
  openZoneOverlayWindows(profileId || 'demo', { demo: !profileId })
}
