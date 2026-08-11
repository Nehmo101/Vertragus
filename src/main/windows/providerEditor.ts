/**
 * The provider editor window — one glass sheet per provider descriptor.
 *
 * Deliberately a sibling of `profileEditor` and not a tab inside it: a profile
 * says "reviewers run on codex", a provider says "codex is started like THIS".
 * The second is edited rarely, is much longer, and is what you open when a CLI
 * changed a flag — mixing it into the profile sheet would bury the three fields
 * people actually touch under twenty they never do.
 *
 * Keyed by provider id, so re-opening the same provider refocuses the window
 * that is already open instead of creating a second, divergent editor for one
 * record. A provider that does not exist yet uses the {@link NEW_PROVIDER_KEY}
 * slot. The key map doubles as the authorization root for the app IPC:
 * `isProviderEditorWindowSender` turns a webContents id into exactly one editor
 * key, mirroring `isProfileEditorWindowSender`.
 */
import { writeFile } from 'node:fs/promises'
import { app, BrowserWindow } from 'electron'
import { glassWindowOptions, loadRoute, secureWindow } from './base'

/** Taller and a little wider than the profile sheet: this form is long. */
export const PROVIDER_EDITOR_WIDTH = 560
export const PROVIDER_EDITOR_HEIGHT = 760
export const PROVIDER_EDITOR_MIN_WIDTH = 460
export const PROVIDER_EDITOR_MIN_HEIGHT = 420

/** Editor slot for a provider that has not been saved yet. */
export const NEW_PROVIDER_KEY = 'new'

interface EditorEntry {
  key: string
  window: BrowserWindow
}

const windows = new Map<string, EditorEntry>()

export function providerEditorKey(providerId?: string): string {
  const id = providerId?.trim()
  return id ? id : NEW_PROVIDER_KEY
}

export function getProviderEditorWindow(key: string): BrowserWindow | null {
  const entry = windows.get(key)
  if (!entry) return null
  if (entry.window.isDestroyed()) {
    windows.delete(key)
    return null
  }
  return entry.window
}

export function listProviderEditorWindows(): { key: string; window: BrowserWindow }[] {
  const alive: { key: string; window: BrowserWindow }[] = []
  for (const [key, entry] of windows) {
    if (entry.window.isDestroyed()) windows.delete(key)
    else alive.push({ key, window: entry.window })
  }
  return alive
}

/** The single source of truth for "is this renderer a provider editor". */
export function isProviderEditorWindowSender(webContentsId: number): string | null {
  for (const { key, window } of listProviderEditorWindows()) {
    if (window.webContents.id === webContentsId) return key
  }
  return null
}

/**
 * Headless verification hook, env-gated exactly like the profile editor's —
 * armed here instead of in the app entry, because this editor is opened by an
 * IPC call and not at boot. `VERTRAGUS_PROVIDER_EDITOR_SCREENSHOT=<png>`
 * captures the window once it has loaded and exits.
 */
function armEditorScreenshot(win: BrowserWindow, delayMs = 4_000): void {
  const target = process.env['VERTRAGUS_PROVIDER_EDITOR_SCREENSHOT']
  if (!target) return
  win.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      try {
        const image = await win.webContents.capturePage()
        await writeFile(target, image.toPNG())
        app.exit(0)
      } catch (error) {
        console.error('[smoke] capture failed (provider editor):', error)
        app.exit(1)
      }
    }, delayMs)
  })
}

/**
 * Owner verification of the editor's glass rendering without touching the app
 * entry: with `VERTRAGUS_PROVIDER_EDITOR_SCREENSHOT` set, the editor opens on
 * boot (for `VERTRAGUS_PROVIDER_EDITOR_PROVIDER`, or empty for a new provider),
 * is captured and the app exits. Called once from the app entry, next to the
 * other boot-time smoke hooks — never from `registerAppIpc`, which must stay a
 * pure IPC registration.
 */
export function armProviderEditorSmoke(): void {
  if (!process.env['VERTRAGUS_PROVIDER_EDITOR_SCREENSHOT']) return
  openProviderEditorWindow(process.env['VERTRAGUS_PROVIDER_EDITOR_PROVIDER'])
}

export function openProviderEditorWindow(providerId?: string): BrowserWindow {
  const key = providerEditorKey(providerId)
  const existing = getProviderEditorWindow(key)
  if (existing) {
    if (existing.isMinimized()) existing.restore()
    existing.show()
    existing.focus()
    return existing
  }

  const win = new BrowserWindow({
    ...glassWindowOptions(),
    width: PROVIDER_EDITOR_WIDTH,
    height: PROVIDER_EDITOR_HEIGHT,
    minWidth: PROVIDER_EDITOR_MIN_WIDTH,
    minHeight: PROVIDER_EDITOR_MIN_HEIGHT,
    resizable: true,
    // Never always-on-top: the editor is a task, not a HUD.
    alwaysOnTop: false,
    title: 'Vertragus — Provider'
  })
  secureWindow(win)
  loadRoute(
    win,
    key === NEW_PROVIDER_KEY ? '/provider-editor' : `/provider-editor/${encodeURIComponent(key)}`
  )
  win.on('ready-to-show', () => win.show())
  win.on('closed', () => {
    const entry = windows.get(key)
    if (entry?.window === win) windows.delete(key)
  })
  armEditorScreenshot(win)

  windows.set(key, { key, window: win })
  return win
}

export function closeProviderEditorWindow(key: string): void {
  const win = getProviderEditorWindow(key)
  windows.delete(key)
  if (win) win.close()
}

/** Close every open editor (app shutdown, provider deleted elsewhere). */
export function closeAllProviderEditorWindows(): void {
  for (const { key } of listProviderEditorWindows()) closeProviderEditorWindow(key)
}
