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
  displayFor,
  forgetWindowPlacement,
  isMovedByUser,
  markMovedByUser,
  planLiveReflow,
  planWindowLayout,
  rectsEqual,
  setLiveReflowHandler,
  trackWindowMoves,
  type AgentWindowInfo,
  type DisplayInfo,
  type LiveWindowInfo,
  type PlacedWindow,
  type RailInfo,
  type Rect
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
  /**
   * Fired once a live-reflow gesture has rewritten the zones. Workspace uses
   * this to keep the in-memory profile (and optional disk save) in sync.
   */
  onZonesChange?: (zones: ZoneLayout) => void
  /**
   * Tiling group. Windows of another workspace are never re-tiled together
   * with this one; omitted ids group with each other.
   */
  workspaceId?: string
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
  /**
   * Bounds from just before the window was grown — present exactly while it is
   * filling its screen, and therefore also the flag "this one is maximized".
   * Only a fallback for the way back: shrinking aims at the zone (see
   * {@link toggleCliWindowMaximized}).
   */
  restoreBounds?: Rect
  /** Display the window last settled on — compared to the center after a drag. */
  lastDisplayId?: number
}

const windows = new Map<string, CliWindowEntry>()
/** Panel refresh: a closed window must drop its ✕ and stay listed as finished. */
const closedListeners = new Set<(agentId: string) => void>()

/** Subscribe to CLI windows disappearing — closed by the user or by stop. */
export function onCliWindowClosed(listener: (agentId: string) => void): () => void {
  closedListeners.add(listener)
  return () => {
    closedListeners.delete(listener)
  }
}

function notifyClosed(agentId: string): void {
  for (const listener of [...closedListeners]) listener(agentId)
}

export function cliWindowTitle(agentName: string): string {
  return `Vertragus — ${agentName}`
}

/** The live registry entry, or null — a destroyed window is pruned on the way. */
function liveEntry(agentId: string): CliWindowEntry | null {
  const entry = windows.get(agentId)
  if (!entry) return null
  if (entry.window.isDestroyed()) {
    windows.delete(agentId)
    return null
  }
  return entry
}

export function getCliWindow(agentId: string): BrowserWindow | null {
  return liveEntry(agentId)?.window ?? null
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

function rememberDisplay(agentId: string, bounds: Rect): void {
  const entry = windows.get(agentId)
  if (!entry) return
  const host = displayFor(bounds, currentDisplays())
  if (host) entry.lastDisplayId = host.id
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
  const host = displayFor(bounds, displays)
  if (!host) return undefined
  const centerX = bounds.x + bounds.width / 2
  const edge = centerX > host.workArea.x + host.workArea.width / 2 ? 'right' : 'left'
  return { displayId: host.id, edge, width: bounds.width }
}

/** Tiling group for a live window — omitted workspace ids group with each other. */
function windowWorkspaceId(agentId: string): string | undefined {
  return windows.get(agentId)?.options.placement?.workspaceId
}

function toAgentWindowInfo(agentId: string, roleId: string): AgentWindowInfo {
  return {
    agentId,
    roleId,
    // A maximized window is as deliberate as a dragged one: re-tiling it out
    // of full screen because somebody else started an agent is not on.
    movedByUser: isMovedByUser(agentId) || isCliWindowMaximized(agentId)
  }
}

/**
 * Bounds for the window about to open, plus the re-tiling of the ones already
 * in the same workspace. Windows with no workspaceId group with each other.
 * Windows the user dragged are not in the plan — see placement.ts.
 */
function zonesForPlan(placement: CliWindowPlacement): ZoneLayout | undefined {
  if (placement.zones) return placement.zones
  for (const { agentId } of listCliWindows()) {
    const zones = windows.get(agentId)?.options.placement?.zones
    if (zones && zones.zones.length > 0) return zones
  }
  return undefined
}

function planFor(agentId: string, placement: CliWindowPlacement): PlacedWindow[] {
  const displays = currentDisplays()
  const existing: AgentWindowInfo[] = listCliWindows()
    .filter((entry) => entry.agentId !== agentId)
    .filter((entry) => windowWorkspaceId(entry.agentId) === placement.workspaceId)
    .map((entry) =>
      toAgentWindowInfo(
        entry.agentId,
        windows.get(entry.agentId)?.options.placement?.roleId ?? ''
      )
    )
  const rail = panelRail(displays)
  const zones = zonesForPlan(placement)
  return planWindowLayout({
    ...(zones ? { profile: { zones } } : {}),
    displays,
    ...(rail ? { rail } : {}),
    windows: [...existing, { agentId, roleId: placement.roleId }]
  })
}

/**
 * The live windows a reflow may touch: the gesture's own tiling group. Same
 * rule as {@link planFor} and {@link layoutCliWindows} — a window of another
 * workspace is never re-tiled with this one, and its rectangle must not reach
 * this profile's zones either (omitted workspace ids group with each other).
 */
function liveWindowsForReflow(workspaceId: string | undefined): LiveWindowInfo[] {
  const result: LiveWindowInfo[] = []
  for (const { agentId, window } of listCliWindows()) {
    if (windowWorkspaceId(agentId) !== workspaceId) continue
    const entry = windows.get(agentId)
    result.push({
      agentId,
      roleId: entry?.options.placement?.roleId ?? '',
      bounds: window.getBounds(),
      maximized: isCliWindowMaximized(agentId)
    })
  }
  return result
}

/**
 * Apply a settled user drag/resize: reflow neighbors on this display, rewrite
 * each window's zones, persist once via the gesture window's callback.
 */
function reflowLiveNeighbors(agentId: string): void {
  const entry = liveEntry(agentId)
  if (!entry?.options.placement) return
  const persist = entry.options.placement.onZonesChange

  const displays = currentDisplays()
  const nextRect = entry.window.getBounds()
  const previousDisplayId = entry.lastDisplayId ?? displayFor(nextRect, displays)?.id
  if (previousDisplayId === undefined) return

  const rail = panelRail(displays)
  const workspaceId = entry.options.placement.workspaceId
  const existingZones = zonesForPlan(entry.options.placement)
  const plan = planLiveReflow({
    windows: liveWindowsForReflow(workspaceId),
    movedId: agentId,
    nextRect,
    previousDisplayId,
    displays,
    ...(rail ? { rail } : {}),
    minWidth: CLI_MIN_WIDTH,
    minHeight: CLI_MIN_HEIGHT,
    ...(existingZones ? { existingZones } : {})
  })
  if (!plan) return

  for (const id of plan.markMoved) markMovedByUser(id)

  for (const placed of plan.placements) {
    // The OS already has the user's bounds. Applying a clamp would start
    // programmatic grace and swallow the rest of the drag.
    if (placed.agentId === agentId) continue
    const win = getCliWindow(placed.agentId)
    if (!win) continue
    if (rectsEqual(win.getBounds(), placed.bounds)) continue
    applyWindowBounds(placed.agentId, win, placed.bounds)
    rememberDisplay(placed.agentId, placed.bounds)
  }
  rememberDisplay(agentId, entry.window.getBounds())

  for (const { agentId: otherId } of listCliWindows()) {
    if (windowWorkspaceId(otherId) !== workspaceId) continue
    const other = windows.get(otherId)
    const placement = other?.options.placement
    if (!placement) continue
    other.options.placement = { ...placement, zones: plan.zones }
  }
  persist?.(plan.zones)
}

setLiveReflowHandler(reflowLiveNeighbors)

/**
 * Another live CLI already has the keyboard. The window being reused is
 * excluded so its own isFocused() does not suppress the show+focus path.
 */
function anotherCliWindowIsFocused(except: BrowserWindow): boolean {
  for (const { window } of listCliWindows()) {
    if (window === except) continue
    if (window.isFocused()) return true
  }
  return false
}

/**
 * Snap these agents' CLI windows into their profile zones (or auto-tiles).
 * Only the first placement's workspace takes part — same grouping as
 * {@link planFor} (omitted workspace ids group with each other). Drops the
 * moved-by-user mark so a workspace click is a "go home", the same idea as
 * shrinking from maximize. Maximized windows are left alone.
 */
export function layoutCliWindows(agentIds: readonly string[]): void {
  const entries: CliWindowEntry[] = []
  for (const agentId of agentIds) {
    const entry = liveEntry(agentId)
    if (entry) entries.push(entry)
  }
  if (entries.length === 0) return

  const placement = entries.find((entry) => entry.options.placement)?.options.placement
  if (!placement) return

  const scoped = entries.filter(
    (entry) => windowWorkspaceId(entry.agentId) === placement.workspaceId
  )
  if (scoped.length === 0) return

  for (const entry of scoped) {
    if (isCliWindowMaximized(entry.agentId)) continue
    forgetWindowPlacement(entry.agentId)
  }

  const displays = currentDisplays()
  const rail = panelRail(displays)
  const plan = planWindowLayout({
    ...(placement.zones ? { profile: { zones: placement.zones } } : {}),
    displays,
    ...(rail ? { rail } : {}),
    windows: scoped.map((entry) =>
      toAgentWindowInfo(entry.agentId, entry.options.placement?.roleId ?? placement.roleId)
    )
  })

  for (const placed of plan) {
    if (isCliWindowMaximized(placed.agentId)) continue
    const win = getCliWindow(placed.agentId)
    if (win) applyWindowBounds(placed.agentId, win, placed.bounds)
  }
}

export function createCliWindow(agentId: string, options: CliWindowOptions): BrowserWindow {
  const existing = getCliWindow(agentId)
  if (existing) {
    // show() activates; do not steal keystrokes from another live CLI.
    if (anotherCliWindowIsFocused(existing)) existing.showInactive()
    else {
      existing.show()
      existing.focus()
    }
    return existing
  }

  const plan = options.bounds || !options.placement ? [] : planFor(agentId, options.placement)
  const placed = plan.find((entry) => entry.agentId === agentId)?.bounds
  const bounds = options.bounds ?? placed

  // Windows: new BrowserWindow() can steal OS focus before ready-to-show.
  const keepKeyboard = listCliWindows().some(({ window }) => window.isFocused())

  const win = new BrowserWindow({
    ...glassWindowOptions(),
    width: bounds?.width ?? CLI_DEFAULT_WIDTH,
    height: bounds?.height ?? CLI_DEFAULT_HEIGHT,
    ...(bounds?.x !== undefined ? { x: bounds.x } : {}),
    ...(bounds?.y !== undefined ? { y: bounds.y } : {}),
    minWidth: CLI_MIN_WIDTH,
    minHeight: CLI_MIN_HEIGHT,
    resizable: true,
    // Grow/shrink is ours, not the OS's: the title bar's button fills the
    // screen and puts the window back in its ZONE, which native
    // maximize/unmaximize cannot do — it only knows the bounds from before.
    // Leaving the native path enabled would give a double-click on the drag
    // region a second, conflicting idea of what "maximized" means.
    maximizable: false,
    // Never alwaysOnTop: agent windows must be able to sit behind the editor.
    alwaysOnTop: false,
    title: cliWindowTitle(options.title)
  })
  secureWindow(win)
  loadRoute(win, `/agent/${encodeURIComponent(agentId)}`)
  win.on('ready-to-show', () => {
    if (keepKeyboard) win.showInactive()
    else win.show()
    // Constructor x/y is a hint. Linux compositors often ignore it until
    // after `show`; pinning here is what actually lands the window on the
    // target display.
    if (
      bounds &&
      bounds.x !== undefined &&
      bounds.y !== undefined &&
      bounds.width !== undefined &&
      bounds.height !== undefined
    ) {
      applyWindowBounds(agentId, win, {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height
      })
    }
  })
  win.on('closed', () => {
    const entry = windows.get(agentId)
    if (entry?.window === win) windows.delete(agentId)
    // A reopened agent tiles again; the old "user moved it" mark is stale.
    forgetWindowPlacement(agentId)
    notifyClosed(agentId)
  })

  windows.set(agentId, { agentId, window: win, options })

  if (options.placement) {
    // Watch for user drags BEFORE re-tiling, so our own setBounds calls are
    // inside the guard window and are not mistaken for a manual move.
    setLiveReflowHandler(reflowLiveNeighbors)
    trackWindowMoves(agentId, win, undefined, () => {
      // Reflow-off pin path: lastDisplayId must follow the user, or a later
      // reflow-on resize is misread as a cross-display jump.
      rememberDisplay(agentId, win.getBounds())
    })
    rememberDisplay(agentId, win.getBounds())
    for (const entry of plan) {
      if (entry.agentId === agentId) continue
      const other = getCliWindow(entry.agentId)
      if (other) {
        applyWindowBounds(entry.agentId, other, entry.bounds)
        rememberDisplay(entry.agentId, entry.bounds)
      }
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

/** Minimize the window — it stays in the registry and the agent keeps running. */
export function minimizeCliWindow(agentId: string): void {
  const win = getCliWindow(agentId)
  if (win) win.minimize()
}

/** Is this agent's window currently filling its screen? */
export function isCliWindowMaximized(agentId: string): boolean {
  return liveEntry(agentId)?.restoreBounds !== undefined
}

/**
 * Where "shrink" sends the window: its zone, or its auto-tiled slot when the
 * profile has none.
 *
 * The manual-move mark is dropped first on purpose. It exists so tiling never
 * undoes a drag — but this click IS the user asking for the window to go home,
 * and a window that was dragged out of its zone before being maximized must
 * still land back in it.
 */
function homeBounds(entry: CliWindowEntry): Rect | undefined {
  const placement = entry.options.placement
  if (!placement) return undefined
  forgetWindowPlacement(entry.agentId)
  return planFor(entry.agentId, placement).find((plan) => plan.agentId === entry.agentId)?.bounds
}

/**
 * The title bar's grow/shrink button.
 *
 * Grow fills the work area of the screen the window sits on — the work area and
 * not the raw display, so a full-screen terminal never buries the taskbar.
 * Shrink puts it back into its zone (see {@link homeBounds}), which is why this
 * is not Electron's `maximize()`/`unmaximize()`: those only remember the bounds
 * from before and would hand a dragged-away terminal straight back to where it
 * was dragged.
 *
 * Answers with the state the window is in afterwards.
 */
export function toggleCliWindowMaximized(agentId: string): boolean {
  const entry = liveEntry(agentId)
  if (!entry) return false
  const win = entry.window

  if (entry.restoreBounds) {
    const target = homeBounds(entry) ?? entry.restoreBounds
    delete entry.restoreBounds
    applyWindowBounds(agentId, win, target)
    return false
  }

  const bounds = win.getBounds()
  const displays = currentDisplays()
  const host = displayFor(bounds, displays) ?? displays.find((display) => display.primary)
  if (!host) return false
  entry.restoreBounds = bounds
  applyWindowBounds(agentId, win, host.workArea)
  return true
}

/** Bring an agent's window to the front (panel click, M3). */
export function focusCliWindow(agentId: string): void {
  const win = getCliWindow(agentId)
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}
