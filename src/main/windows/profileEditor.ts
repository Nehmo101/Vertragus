/**
 * The profile editor window — one small glass sheet per profile.
 *
 * Unlike the panel it is NOT always-on-top and it IS resizable: editing a
 * profile is a focused task that may need room (slot grid, role prompts), and a
 * modal-feeling sheet floating over every other app is a nuisance.
 *
 * Keyed by profile id, so re-opening the same profile refocuses the window that
 * is already open instead of creating a second, divergent editor for the same
 * record. A profile that does not exist yet uses the {@link NEW_PROFILE_KEY}
 * slot. The key map doubles as the authorization root for the app IPC:
 * `isProfileEditorWindowSender` turns a webContents id into exactly one editor
 * key, mirroring `isCliWindowSender`.
 */
import { BrowserWindow } from 'electron'
import { mainMessages, readLocale } from '@shared/mainMessages'
import { getSettings } from '@main/store/settings'
import { glassWindowOptions, loadRoute, secureWindow } from './base'
import { armWindowCapture } from './smokeCapture'

export const PROFILE_EDITOR_WIDTH = 520
export const PROFILE_EDITOR_HEIGHT = 660
export const PROFILE_EDITOR_MIN_WIDTH = 460
export const PROFILE_EDITOR_MIN_HEIGHT = 420

/** Editor slot for a profile that has not been saved yet. */
export const NEW_PROFILE_KEY = 'new'

interface EditorEntry {
  key: string
  window: BrowserWindow
}

const windows = new Map<string, EditorEntry>()

export function profileEditorKey(profileId?: string): string {
  const id = profileId?.trim()
  return id ? id : NEW_PROFILE_KEY
}

export function getProfileEditorWindow(key: string): BrowserWindow | null {
  const entry = windows.get(key)
  if (!entry) return null
  if (entry.window.isDestroyed()) {
    windows.delete(key)
    return null
  }
  return entry.window
}

export function listProfileEditorWindows(): { key: string; window: BrowserWindow }[] {
  const alive: { key: string; window: BrowserWindow }[] = []
  for (const [key, entry] of windows) {
    if (entry.window.isDestroyed()) windows.delete(key)
    else alive.push({ key, window: entry.window })
  }
  return alive
}

/** The single source of truth for "is this renderer a profile editor". */
export function isProfileEditorWindowSender(webContentsId: number): string | null {
  for (const { key, window } of listProfileEditorWindows()) {
    if (window.webContents.id === webContentsId) return key
  }
  return null
}

/**
 * Headless verification hook, env-gated exactly like the panel/CLI ones — but
 * armed here instead of in the app entry, because the editor is opened by an
 * IPC call and not at boot. `VERTRAGUS_PROFILE_EDITOR_SCREENSHOT=<png>` captures
 * the window once it has loaded and exits.
 */
function armEditorScreenshot(win: BrowserWindow, delayMs = 4_000): void {
  armWindowCapture(win, 'VERTRAGUS_PROFILE_EDITOR_SCREENSHOT', 'profile editor', delayMs)
}

/**
 * Owner verification of the editor's glass rendering without touching the app
 * entry: with `VERTRAGUS_PROFILE_EDITOR_SCREENSHOT` set, the editor opens on
 * boot (for `VERTRAGUS_PROFILE_EDITOR_PROFILE`, or empty for a new profile),
 * is captured and the app exits. Called once from the app entry, next to the
 * other boot-time smoke hooks — never from `registerAppIpc`, which must stay a
 * pure IPC registration.
 */
export function armProfileEditorSmoke(): void {
  if (!process.env['VERTRAGUS_PROFILE_EDITOR_SCREENSHOT']) return
  openProfileEditorWindow(process.env['VERTRAGUS_PROFILE_EDITOR_PROFILE'])
}

export function openProfileEditorWindow(profileId?: string): BrowserWindow {
  const key = profileEditorKey(profileId)
  const existing = getProfileEditorWindow(key)
  if (existing) {
    if (existing.isMinimized()) existing.restore()
    existing.show()
    existing.focus()
    return existing
  }

  const win = new BrowserWindow({
    ...glassWindowOptions(),
    width: PROFILE_EDITOR_WIDTH,
    height: PROFILE_EDITOR_HEIGHT,
    minWidth: PROFILE_EDITOR_MIN_WIDTH,
    minHeight: PROFILE_EDITOR_MIN_HEIGHT,
    resizable: true,
    // Never always-on-top: the editor is a task, not a HUD.
    alwaysOnTop: false,
    // OS-chrome title in the stored locale (see settingsWindow.ts).
    title: mainMessages(readLocale(() => getSettings().ui.locale)).profileEditorTitle
  })
  secureWindow(win)
  loadRoute(win, key === NEW_PROFILE_KEY ? '/profile-editor' : `/profile-editor/${encodeURIComponent(key)}`)
  win.on('ready-to-show', () => win.show())
  win.on('closed', () => {
    const entry = windows.get(key)
    if (entry?.window === win) windows.delete(key)
  })
  armEditorScreenshot(win)

  windows.set(key, { key, window: win })
  return win
}

export function closeProfileEditorWindow(key: string): void {
  const win = getProfileEditorWindow(key)
  windows.delete(key)
  if (win) win.close()
}

/** Close every open editor (app shutdown, profile deleted elsewhere). */
export function closeAllProfileEditorWindows(): void {
  for (const { key } of listProfileEditorWindows()) closeProfileEditorWindow(key)
}
