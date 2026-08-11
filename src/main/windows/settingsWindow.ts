/**
 * The settings window — the sheet behind the panel's gear.
 *
 * Built exactly like the profile editor (glass, frameless, resizable, never
 * always-on-top) with one difference: there is only ever ONE of it. Settings
 * are app-wide, so a second window would be a second view of the same record
 * with its own unsaved state — the classic way to lose a change by closing the
 * wrong twin. `openSettingsWindow()` therefore refocuses whatever is open.
 *
 * The registry doubles as an authorization root for the app IPC:
 * `isSettingsWindowSender` turns a webContents id into "yes, this is the
 * settings window", which is what lets `settings:set` accept writes from here
 * and from nowhere else except the panel.
 */
import { writeFile } from 'node:fs/promises'
import { app, BrowserWindow } from 'electron'
import { glassWindowOptions, loadRoute, secureWindow } from './base'

export const SETTINGS_WINDOW_WIDTH = 480
// Measured against the rendered sheet: tall enough that the update block is on
// screen without scrolling (the thing people open this window for), short
// enough that there is no empty half below it.
export const SETTINGS_WINDOW_HEIGHT = 570
export const SETTINGS_WINDOW_MIN_WIDTH = 420
export const SETTINGS_WINDOW_MIN_HEIGHT = 420

/** Stable key for hide-all's bookkeeping; there is only one window. */
export const SETTINGS_WINDOW_KEY = 'settings'

let current: BrowserWindow | undefined

export function getSettingsWindow(): BrowserWindow | null {
  if (!current) return null
  if (current.isDestroyed()) {
    current = undefined
    return null
  }
  return current
}

/** Shaped like the other registries so hide-all can treat them alike. */
export function listSettingsWindows(): { key: string; window: BrowserWindow }[] {
  const win = getSettingsWindow()
  return win ? [{ key: SETTINGS_WINDOW_KEY, window: win }] : []
}

/** The single source of truth for "is this renderer the settings window". */
export function isSettingsWindowSender(webContentsId: number): boolean {
  const win = getSettingsWindow()
  return win !== null && win.webContents.id === webContentsId
}

/**
 * Headless verification hook, env-gated exactly like the profile editor's:
 * `VERTRAGUS_SETTINGS_SCREENSHOT=<png>` captures the window once it has loaded
 * and exits. Armed from the app entry, next to the other boot smoke hooks.
 */
function armSettingsScreenshot(win: BrowserWindow, delayMs = 3_000): void {
  const target = process.env['VERTRAGUS_SETTINGS_SCREENSHOT']
  if (!target) return
  win.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      try {
        const image = await win.webContents.capturePage()
        await writeFile(target, image.toPNG())
        app.exit(0)
      } catch (error) {
        console.error('[smoke] capture failed (settings):', error)
        app.exit(1)
      }
    }, delayMs)
  })
}

/** Boot-time owner verification of the settings sheet; a no-op without the env. */
export function armSettingsWindowSmoke(): void {
  if (!process.env['VERTRAGUS_SETTINGS_SCREENSHOT']) return
  openSettingsWindow()
}

export function openSettingsWindow(): BrowserWindow {
  const existing = getSettingsWindow()
  if (existing) {
    if (existing.isMinimized()) existing.restore()
    existing.show()
    existing.focus()
    return existing
  }

  const win = new BrowserWindow({
    ...glassWindowOptions(),
    width: SETTINGS_WINDOW_WIDTH,
    height: SETTINGS_WINDOW_HEIGHT,
    minWidth: SETTINGS_WINDOW_MIN_WIDTH,
    minHeight: SETTINGS_WINDOW_MIN_HEIGHT,
    resizable: true,
    alwaysOnTop: false,
    title: 'Vertragus — Einstellungen'
  })
  secureWindow(win)
  loadRoute(win, '/settings')
  win.on('ready-to-show', () => win.show())
  win.on('closed', () => {
    if (current === win) current = undefined
  })
  armSettingsScreenshot(win)

  current = win
  return win
}

export function closeSettingsWindow(): void {
  const win = getSettingsWindow()
  current = undefined
  if (win) win.close()
}
