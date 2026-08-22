import { BrowserWindow, screen } from 'electron'
import { getSettings, setSetting, type PanelBounds } from '@main/store/settings'
import { glassWindowOptions, loadRoute, secureWindow } from './base'
import { attachPanelHoverTracking } from './panelHover'
import { panelBoundsFromPosition, panelPlacement, PANEL_WIDTH } from './panelPlacement'

export { PANEL_MARGIN, PANEL_MAX_HEIGHT, PANEL_WIDTH } from './panelPlacement'

/**
 * One position write per drop, not one per pixel: `move` fires continuously
 * while the user drags, and the store is a JSON file on disk.
 */
export const PANEL_BOUNDS_SAVE_DEBOUNCE_MS = 400

let panelWindow: BrowserWindow | null = null

export function getPanelWindow(): BrowserWindow | null {
  return panelWindow && !panelWindow.isDestroyed() ? panelWindow : null
}

export function isPanelWindowSender(webContentsId: number): boolean {
  const win = getPanelWindow()
  return win !== null && win.webContents.id === webContentsId
}

/**
 * The panel is the app's primary surface: a small always-on-top glass strip
 * docked to a screen edge. Which edge — and how far down — survives restarts
 * via `ui.panelBounds`; geometry itself lives in {@link panelPlacement} so a
 * shrunken display can never strand the panel off-screen.
 */
export function createPanelWindow(): BrowserWindow {
  const existing = getPanelWindow()
  if (existing) {
    // The panel can be minimized by its own − (windows:minimizePanel), so
    // "bring the app back" has to undo that and not just re-show a window that
    // is already visible-but-iconified.
    if (existing.isMinimized()) existing.restore()
    existing.show()
    existing.focus()
    return existing
  }

  const workArea = screen.getPrimaryDisplay().workArea
  const placement = panelPlacement(readStoredBounds(), workArea)
  const win = new BrowserWindow({
    ...glassWindowOptions(),
    width: PANEL_WIDTH,
    height: placement.height,
    x: placement.x,
    y: placement.y,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: false,
    alwaysOnTop: true
  })
  win.setAlwaysOnTop(true, 'floating')
  secureWindow(win)
  loadRoute(win, '/panel')
  // The panel drags on its whole surface, which costs it CSS :hover on Windows;
  // the cursor is therefore tracked from the main process. See panelHover.ts.
  attachPanelHoverTracking(win)
  attachBoundsPersistence(win)
  win.on('ready-to-show', () => win.show())
  win.on('closed', () => {
    panelWindow = null
  })
  panelWindow = win
  return win
}

/** Fail-soft: a corrupt store must cost the position, never the panel. */
function readStoredBounds(): PanelBounds | undefined {
  try {
    return getSettings().ui.panelBounds
  } catch {
    return undefined
  }
}

function attachBoundsPersistence(win: BrowserWindow): void {
  let timer: ReturnType<typeof setTimeout> | undefined
  win.on('move', () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      if (win.isDestroyed()) return
      const bounds = win.getBounds()
      const workArea = screen.getPrimaryDisplay().workArea
      try {
        const ui = getSettings().ui
        setSetting('ui', {
          ...ui,
          panelBounds: panelBoundsFromPosition(bounds.x, bounds.y, workArea)
        })
      } catch {
        // Persistence is an amenity — a failing store write must not surface
        // as an error for a window drag.
      }
    }, PANEL_BOUNDS_SAVE_DEBOUNCE_MS)
    ;(timer as { unref?: () => void }).unref?.()
  })
  win.on('closed', () => {
    if (timer) clearTimeout(timer)
  })
}
