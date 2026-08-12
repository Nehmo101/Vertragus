import { BrowserWindow, screen } from 'electron'
import { glassWindowOptions, loadRoute, secureWindow } from './base'
import { attachPanelHoverTracking } from './panelHover'

export const PANEL_WIDTH = 280
export const PANEL_MAX_HEIGHT = 680
export const PANEL_MARGIN = 12

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
 * docked to a screen edge. Position persistence and edge snapping land in M3
 * together with the settings store; until then it docks to the right edge of
 * the primary display.
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
  const height = Math.min(PANEL_MAX_HEIGHT, workArea.height - PANEL_MARGIN * 2)
  const win = new BrowserWindow({
    ...glassWindowOptions(),
    width: PANEL_WIDTH,
    height,
    x: workArea.x + workArea.width - PANEL_WIDTH - PANEL_MARGIN,
    y: workArea.y + Math.round((workArea.height - height) / 2),
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
  win.on('ready-to-show', () => win.show())
  win.on('closed', () => {
    panelWindow = null
  })
  panelWindow = win
  return win
}
