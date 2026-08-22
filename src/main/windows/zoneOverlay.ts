/**
 * The zone editor overlay — one transparent full-screen sheet, pinned to the
 * monitor the user picked.
 *
 * Zones are drawn ON the screen they will apply to, because that is the only
 * honest preview: a miniature monitor picker inside the profile editor cannot
 * show what "the right third of the second display" actually feels like. So
 * "Zonen festlegen" opens one frameless, transparent, always-on-top overlay,
 * sized to a display's WORK AREA (not its full bounds — a zone under the
 * taskbar would place windows the user cannot reach).
 *
 * With several monitors attached, one overlay opens on the screen the user
 * just clicked from and lists every attached display. Clicking a name moves
 * that overlay onto the chosen work area (constructor x/y is ignored on some
 * Linux compositors) and flips it into the rectangle editor. A single monitor
 * skips the picker — there is nothing to choose.
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
import { mainMessages, readLocale } from '@shared/mainMessages'
import { getSettings } from '@main/store/settings'
import { glassWindowOptions, loadRoute, secureWindow } from './base'
import { armWindowCapture } from './smokeCapture'

export interface ZoneOverlaySender {
  profileId: string
  displayId: number
  /** True while this overlay is the multi-monitor picker, not the editor. */
  pick: boolean
}

interface OverlayEntry extends ZoneOverlaySender {
  window: BrowserWindow
}

/** One attached monitor as the overlay / picker labels it. */
export interface ZoneDisplayInfo {
  id: number
  label: string
  width: number
  height: number
  primary: boolean
}

const overlays = new Map<number, OverlayEntry>()
/** True while `closeZoneOverlayWindows` / a picker-narrow runs, so 'closed' does not recurse. */
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
      return { profileId: entry.profileId, displayId: entry.displayId, pick: entry.pick }
    }
  }
  return null
}

/** Displays currently covered by an overlay — the layout replaces exactly these. */
export function zoneOverlayDisplayIds(): number[] {
  return listZoneOverlayWindows().map((entry) => entry.displayId)
}

/** Attached monitors, labelled the way the picker paints them. */
export function listZoneDisplays(): ZoneDisplayInfo[] {
  const primaryId = screen.getPrimaryDisplay().id
  return screen.getAllDisplays().map((display, index) => {
    const label = display.label?.trim()
    return {
      id: display.id,
      label: label && label.length > 0 ? label : `Display ${index + 1}`,
      width: display.workArea.width,
      height: display.workArea.height,
      primary: display.id === primaryId
    }
  })
}

export interface OpenZoneOverlayOptions {
  /**
   * Renderer-side demo layout instead of the profile's zones. Only ever set by
   * the screenshot hook below; it keeps the verification run from having to
   * write a throwaway profile into the user's real store.
   */
  demo?: boolean
}

function overlayQuery(profileId: string, options: { demo?: boolean; pick?: boolean }): string {
  const parts = [`profile=${encodeURIComponent(profileId)}`]
  if (options.demo) parts.push('demo=1')
  if (options.pick) parts.push('pick=1')
  return `?${parts.join('&')}`
}

/** The monitor the picker should appear on: under the cursor, else primary. */
function hostDisplay(displays: readonly Electron.Display[]): Electron.Display {
  if (displays.length <= 1) return displays[0] ?? screen.getPrimaryDisplay()
  const nearest = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  return displays.find((display) => display.id === nearest.id) ?? displays[0]!
}

/**
 * Constructor `x`/`y` is a hint some compositors drop. Pinning after `show`
 * is what actually puts the overlay on the monitor the user picked.
 */
function pinOverlayToDisplay(win: BrowserWindow, displayId: number): void {
  if (win.isDestroyed()) return
  const display = screen.getAllDisplays().find((entry) => entry.id === displayId)
  if (!display) return
  const { workArea } = display
  win.setBounds({
    x: workArea.x,
    y: workArea.y,
    width: workArea.width,
    height: workArea.height
  })
}

function createOverlayWindow(
  profileId: string,
  display: Electron.Display,
  options: { demo?: boolean; pick: boolean; focus: boolean }
): BrowserWindow {
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
    // OS-chrome title in the stored locale (see settingsWindow.ts).
    title: mainMessages(readLocale(() => getSettings().ui.locale)).zoneOverlayTitle
  })
  // Above the always-on-top panel: the overlay is modal in spirit.
  win.setAlwaysOnTop(true, 'screen-saver')
  secureWindow(win)
  pinOverlayToDisplay(win, display.id)
  // Safety valve: the renderer owns Esc, but a full-screen click-eater whose
  // renderer failed to boot must still be closable.
  win.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') closeZoneOverlayWindows()
  })
  loadRoute(win, `/zones/${display.id}${overlayQuery(profileId, options)}`)
  win.on('ready-to-show', () => {
    const live = listZoneOverlayWindows().find((entry) => entry.window === win)
    const displayId = live?.displayId ?? display.id
    pinOverlayToDisplay(win, displayId)
    win.show()
    pinOverlayToDisplay(win, displayId)
    if (options.focus) win.focus()
  })
  // One window gone = session over. Otherwise a half-closed session would
  // save a layout for some displays and silently drop the others.
  // Match by window identity: a picker may rebind the overlay to another
  // display id, and a sibling we already removed must not tear the session
  // down when its `closed` event arrives after `closing` is cleared.
  win.on('closed', () => {
    let tracked: OverlayEntry | undefined
    for (const [id, entry] of overlays) {
      if (entry.window !== win) continue
      tracked = entry
      overlays.delete(id)
      break
    }
    if (tracked && !closing) closeZoneOverlayWindows()
  })
  overlays.set(display.id, {
    profileId,
    displayId: display.id,
    pick: options.pick,
    window: win
  })
  return win
}

/**
 * Open one overlay for this profile. Several monitors start as a picker on
 * the screen under the cursor; a single monitor skips straight to the
 * rectangle editor. Re-opening while a session is running just refocuses it —
 * two overlay sessions would fight over the same profile's layout.
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

  const displays = screen.getAllDisplays()
  if (displays.length === 0) return []
  // Demo captures skip the picker: the screenshot is of the rectangles.
  const pick = !options.demo && displays.length > 1
  const display = options.demo ? displays[0]! : hostDisplay(displays)
  const created = [
    createOverlayWindow(profileId, display, {
      demo: options.demo,
      pick,
      focus: true
    })
  ]
  armZoneOverlayScreenshot(created[0])
  return created
}

/**
 * The user picked this monitor: bind the live overlay to it, pin the window
 * to that work area, and leave picker mode. Unknown ids (unplugged) are a
 * no-op so a stale click cannot kill the session.
 */
export function selectZoneOverlayDisplay(displayId: number): boolean {
  const target = screen.getAllDisplays().find((display) => display.id === displayId)
  if (!target) return false

  const open = listZoneOverlayWindows()
  const kept = open[0]
  if (!kept || kept.window.isDestroyed()) return false

  closing = true
  try {
    for (const entry of open) {
      if (entry.window === kept.window) continue
      overlays.delete(entry.displayId)
      entry.window.close()
    }
  } finally {
    closing = false
  }

  if (kept.displayId !== displayId) {
    overlays.delete(kept.displayId)
    kept.displayId = displayId
    overlays.set(displayId, kept)
  }
  kept.pick = false
  pinOverlayToDisplay(kept.window, displayId)
  kept.window.focus()
  return true
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
