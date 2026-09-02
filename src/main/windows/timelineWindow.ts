/**
 * The timeline window — one glass overview sheet per running workspace.
 *
 * Built like the settings window (glass, frameless, resizable, never
 * always-on-top) with one difference: there is one per `workspaceId`. The sheet
 * is opened by the workspace card's overview button (`focusTimelineWindow` /
 * `openTimelineWindow`), not by Play, resume, or a card click; a second open
 * of the same workspace refocuses. User close is view-only — the workspace
 * keeps running; the overview button (or `openTimelineWindow`) shows it again.
 * `stopWorkspace` is what actually closes it.
 *
 * The registry is an authorization root for the app IPC:
 * `isTimelineWindowSender` turns a webContents id into exactly one workspaceId,
 * so a timeline can mutate only the run it is bound to.
 */
import { BrowserWindow } from 'electron'
import { mainMessages, readLocale } from '@shared/mainMessages'
import { getSettings } from '@main/store/settings'
import { glassWindowOptions, loadRoute, secureWindow } from './base'

export const TIMELINE_WINDOW_WIDTH = 560
export const TIMELINE_WINDOW_HEIGHT = 800
export const TIMELINE_WINDOW_MIN_WIDTH = 420
export const TIMELINE_WINDOW_MIN_HEIGHT = 420

interface TimelineEntry {
  workspaceId: string
  window: BrowserWindow
}

const windows = new Map<string, TimelineEntry>()

export function timelineWindowRoute(workspaceId: string): string {
  return `/timeline/${encodeURIComponent(workspaceId)}`
}

/** The live window for this workspace, or null — a destroyed window is pruned. */
export function getTimelineWindow(workspaceId: string): BrowserWindow | null {
  const entry = windows.get(workspaceId)
  if (!entry) return null
  if (entry.window.isDestroyed()) {
    windows.delete(workspaceId)
    return null
  }
  return entry.window
}

/** Shaped like the other registries so hide-all can treat them alike. */
export function listTimelineWindows(): { workspaceId: string; window: BrowserWindow }[] {
  const alive: { workspaceId: string; window: BrowserWindow }[] = []
  for (const [workspaceId, entry] of windows) {
    if (entry.window.isDestroyed()) windows.delete(workspaceId)
    else alive.push({ workspaceId, window: entry.window })
  }
  return alive
}

/**
 * The single source of truth for "is this renderer a timeline, and of which
 * workspace". Null for every other window.
 */
export function isTimelineWindowSender(webContentsId: number): string | null {
  for (const { workspaceId, window } of listTimelineWindows()) {
    if (window.webContents.id === webContentsId) return workspaceId
  }
  return null
}

/**
 * Open (or refocus) the overview window for this workspace. Identity: a second
 * open of the same workspaceId does not twin the sheet.
 *
 * The CLI "start in the background" flag does not apply here.
 */
export function openTimelineWindow(workspaceId: string): BrowserWindow {
  const existing = getTimelineWindow(workspaceId)
  if (existing) {
    if (existing.isMinimized()) existing.restore()
    existing.show()
    existing.focus()
    return existing
  }

  const win = new BrowserWindow({
    ...glassWindowOptions(),
    width: TIMELINE_WINDOW_WIDTH,
    height: TIMELINE_WINDOW_HEIGHT,
    minWidth: TIMELINE_WINDOW_MIN_WIDTH,
    minHeight: TIMELINE_WINDOW_MIN_HEIGHT,
    resizable: true,
    alwaysOnTop: false,
    title: mainMessages(readLocale(() => getSettings().ui.locale)).timelineWindowTitle
  })
  secureWindow(win)
  loadRoute(win, timelineWindowRoute(workspaceId))
  win.on('ready-to-show', () => win.show())
  win.on('closed', () => {
    const entry = windows.get(workspaceId)
    if (entry?.window === win) windows.delete(workspaceId)
  })

  windows.set(workspaceId, { workspaceId, window: win })
  return win
}

/**
 * Hide every other timeline (`hide()`, never minimize), then restore if the
 * sheet is taskbar-minimized, `showInactive` this one and steal focus once. A
 * closed sheet is reopened — the workspace card's overview button is how a
 * view-only close comes back.
 */
export function focusTimelineWindow(workspaceId: string): void {
  for (const { workspaceId: otherId, window } of listTimelineWindows()) {
    if (otherId === workspaceId) continue
    if (!window.isVisible() && !window.isMinimized()) continue
    window.hide()
  }
  const existing = getTimelineWindow(workspaceId)
  if (!existing) {
    openTimelineWindow(workspaceId)
    return
  }
  // Taskbar-minimized on Windows stays minimized through showInactive alone.
  if (existing.isMinimized()) existing.restore()
  existing.showInactive()
  existing.focus()
}

export function closeTimelineWindow(workspaceId: string): void {
  const win = getTimelineWindow(workspaceId)
  windows.delete(workspaceId)
  if (win) win.close()
}
