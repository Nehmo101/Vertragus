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
import { BrowserWindow, screen } from 'electron'
import type { ZoneLayout } from '@shared/schema/zones'
import { glassWindowOptions, loadRoute, secureWindow } from './base'
import { getPanelWindow } from './panel'
import {
  applyWindowBounds,
  forgetWindowPlacement,
  isMovedByUser,
  planWindowLayout,
  trackWindowMoves,
  type AgentWindowInfo,
  type DisplayInfo,
  type PlacedWindow,
  type RailInfo
} from './placement'

export const CLI_MIN_WIDTH = 420
export const CLI_MIN_HEIGHT = 300
export const CLI_DEFAULT_WIDTH = 760
export const CLI_DEFAULT_HEIGHT = 480

/** What the placement layer needs to know about the agent behind this window. */
export interface CliWindowPlacement {
  /** Role key; `orchestrator` for the orchestrator. Selects the zone. */
  roleId: string
  /** The profile's zone layout, if it has one. */
  zones?: ZoneLayout
}

export interface CliWindowOptions {
  /** Agent name — shown as "Vertragus — <name>". */
  title: string
  /** Role accent used by the renderer title bar; kept here for re-creation. */
  roleColor: string
  bounds?: Partial<Electron.Rectangle>
  /**
   * Let the placement layer choose the bounds (zone, else auto-tiling) and
   * re-tile the other untouched windows. Explicit `bounds` always win; without
   * either, the window opens at Electron's default position.
   */
  placement?: CliWindowPlacement
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

/** The attached monitors as the placement layer sees them. */
function currentDisplays(): DisplayInfo[] {
  const primaryId = screen.getPrimaryDisplay().id
  return screen.getAllDisplays().map((display) => ({
    id: display.id,
    workArea: display.workArea,
    primary: display.id === primaryId
  }))
}

/**
 * The strip the panel occupies, so auto-tiling does not open terminals
 * underneath it. Derived from the live window instead of the settings store:
 * the panel is draggable, and what matters is where it is right now.
 */
function panelRail(displays: readonly DisplayInfo[]): RailInfo | undefined {
  const panel = getPanelWindow()
  if (!panel) return undefined
  const bounds = panel.getBounds()
  const centerX = bounds.x + bounds.width / 2
  const centerY = bounds.y + bounds.height / 2
  const host = displays.find(
    ({ workArea }) =>
      centerX >= workArea.x &&
      centerX < workArea.x + workArea.width &&
      centerY >= workArea.y &&
      centerY < workArea.y + workArea.height
  )
  if (!host) return undefined
  const edge = centerX > host.workArea.x + host.workArea.width / 2 ? 'right' : 'left'
  return { displayId: host.id, edge, width: bounds.width }
}

/**
 * Bounds for the window about to open, plus the re-tiling of the ones already
 * there. Windows the user dragged are not in the plan — see placement.ts.
 */
function planFor(agentId: string, placement: CliWindowPlacement): PlacedWindow[] {
  const displays = currentDisplays()
  const existing: AgentWindowInfo[] = listCliWindows()
    .filter((entry) => entry.agentId !== agentId)
    .map((entry) => ({
      agentId: entry.agentId,
      roleId: windows.get(entry.agentId)?.options.placement?.roleId ?? '',
      movedByUser: isMovedByUser(entry.agentId)
    }))
  const rail = panelRail(displays)
  return planWindowLayout({
    ...(placement.zones ? { profile: { zones: placement.zones } } : {}),
    displays,
    ...(rail ? { rail } : {}),
    windows: [...existing, { agentId, roleId: placement.roleId }]
  })
}

export function createCliWindow(agentId: string, options: CliWindowOptions): BrowserWindow {
  const existing = getCliWindow(agentId)
  if (existing) {
    existing.show()
    existing.focus()
    return existing
  }

  const plan = options.bounds || !options.placement ? [] : planFor(agentId, options.placement)
  const placed = plan.find((entry) => entry.agentId === agentId)?.bounds
  const bounds = options.bounds ?? placed

  const win = new BrowserWindow({
    ...glassWindowOptions(),
    width: bounds?.width ?? CLI_DEFAULT_WIDTH,
    height: bounds?.height ?? CLI_DEFAULT_HEIGHT,
    ...(bounds?.x !== undefined ? { x: bounds.x } : {}),
    ...(bounds?.y !== undefined ? { y: bounds.y } : {}),
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
    // A reopened agent tiles again; the old "user moved it" mark is stale.
    forgetWindowPlacement(agentId)
  })

  windows.set(agentId, { agentId, window: win, options })

  if (options.placement) {
    // Watch for user drags BEFORE re-tiling, so our own setBounds calls are
    // inside the guard window and are not mistaken for a manual move.
    trackWindowMoves(agentId, win)
    for (const entry of plan) {
      if (entry.agentId === agentId) continue
      const other = getCliWindow(entry.agentId)
      if (other) applyWindowBounds(entry.agentId, other, entry.bounds)
    }
  }
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
