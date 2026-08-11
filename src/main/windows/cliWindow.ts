/**
 * One glass window per agent — the CLI surface.
 *
 * Same transparency contract as the panel, but never always-on-top: a worker's
 * terminal must be able to go behind the editor. The window is frameless; the
 * title bar (drag region, role accent, close) is drawn by the renderer, which
 * is why the OS title only matters for the taskbar and window switchers.
 *
 * The agentId ↔ window map is the authorization root for the terminal IPC:
 * `isCliWindowSender` turns a webContents id into exactly one agentId, so a
 * CLI window can never address another agent's PTY.
 */
import { BrowserWindow } from 'electron'
import { glassWindowOptions, loadRoute, secureWindow } from './base'

export const CLI_MIN_WIDTH = 420
export const CLI_MIN_HEIGHT = 300
export const CLI_DEFAULT_WIDTH = 760
export const CLI_DEFAULT_HEIGHT = 480

export interface CliWindowOptions {
  /** Agent name — shown as "Vertragus — <name>". */
  title: string
  /** Role accent used by the renderer title bar; kept here for re-creation. */
  roleColor: string
  bounds?: Partial<Electron.Rectangle>
}

interface CliWindowEntry {
  agentId: string
  window: BrowserWindow
  options: CliWindowOptions
}

const windows = new Map<string, CliWindowEntry>()

export function cliWindowTitle(agentName: string): string {
  return `Vertragus — ${agentName}`
}

export function getCliWindow(agentId: string): BrowserWindow | null {
  const entry = windows.get(agentId)
  if (!entry) return null
  if (entry.window.isDestroyed()) {
    windows.delete(agentId)
    return null
  }
  return entry.window
}

export function listCliWindows(): { agentId: string; window: BrowserWindow }[] {
  const alive: { agentId: string; window: BrowserWindow }[] = []
  for (const [agentId, entry] of windows) {
    if (entry.window.isDestroyed()) windows.delete(agentId)
    else alive.push({ agentId, window: entry.window })
  }
  return alive
}

/** The single source of truth for "which agent is this renderer allowed to see". */
export function isCliWindowSender(webContentsId: number): string | null {
  for (const { agentId, window } of listCliWindows()) {
    if (window.webContents.id === webContentsId) return agentId
  }
  return null
}

export function createCliWindow(agentId: string, options: CliWindowOptions): BrowserWindow {
  const existing = getCliWindow(agentId)
  if (existing) {
    existing.show()
    existing.focus()
    return existing
  }

  const win = new BrowserWindow({
    ...glassWindowOptions(),
    width: options.bounds?.width ?? CLI_DEFAULT_WIDTH,
    height: options.bounds?.height ?? CLI_DEFAULT_HEIGHT,
    ...(options.bounds?.x !== undefined ? { x: options.bounds.x } : {}),
    ...(options.bounds?.y !== undefined ? { y: options.bounds.y } : {}),
    minWidth: CLI_MIN_WIDTH,
    minHeight: CLI_MIN_HEIGHT,
    resizable: true,
    // Never alwaysOnTop: agent windows must be able to sit behind the editor.
    alwaysOnTop: false,
    title: cliWindowTitle(options.title)
  })
  secureWindow(win)
  loadRoute(win, `/agent/${encodeURIComponent(agentId)}`)
  win.on('ready-to-show', () => win.show())
  win.on('closed', () => {
    const entry = windows.get(agentId)
    if (entry?.window === win) windows.delete(agentId)
  })

  windows.set(agentId, { agentId, window: win, options })
  return win
}

/** Close the window only — the agent process keeps running. */
export function closeCliWindow(agentId: string): void {
  const win = getCliWindow(agentId)
  windows.delete(agentId)
  if (win) win.close()
}

/** Bring an agent's window to the front (panel click, M3). */
export function focusCliWindow(agentId: string): void {
  const win = getCliWindow(agentId)
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}
