/**
 * One glass window per agent — the CLI surface.
 *
 * Same transparency contract as the panel, but never always-on-top: a worker's
 * terminal must be able to go behind the editor. The window is frameless; the
 * title bar (drag region, role accent, close) is drawn by the renderer, which
 * is why the OS title only matters for the taskbar and window switchers.
 *
 * The agentId ↔ webContents map is the authorization root for the terminal IPC:
 * `isCliWindowSender` turns a webContents id into exactly one agentId, so a
 * CLI window can never address another agent's PTY. In `ui.cliWindowMode ===
 * 'tabs'` that id is the tab *view*'s, never the chrome window's.
 *
 * Tabs mode (frozen per workspaceId on first create, like Play for Pi): one
 * BrowserWindow per workspace, orchestrator and subagents as WebContentsView
 * tabs. Zones / planFor / layoutCliWindows / live reflow do not apply. Fallback
 * if WebContentsView is missing: child BrowserWindows with skipTaskbar, still
 * 1:1 webContents.
 */
import { BrowserWindow, ipcMain, screen, WebContentsView, type WebContents } from 'electron'
import type { ZoneLayout } from '@shared/schema/zones'
import { getSettings } from '@main/store/settings'
import {
  baseWebPreferences,
  glassWindowOptions,
  loadContentsRoute,
  loadRoute,
  secureWebContents,
  secureWindow
} from './base'
import { getPanelWindow } from './panel'
import {
  applyWindowBounds,
  displayFor,
  forgetMovedByUser,
  forgetWindowPlacement,
  isMovedByUser,
  markMovedByUser,
  planLiveReflow,
  planWindowLayout,
  rectsEqual,
  setLiveReflowHandler,
  SNAP_GRACE_MS,
  suppressMoveTracking,
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
/** Tab chrome: strip height the views sit under. */
export const CLI_TAB_STRIP_HEIGHT = 40
export const CLI_CHROME_WIDTH = 960
export const CLI_CHROME_HEIGHT = 640

export const CLI_TAB_CHANNELS = {
  attach: 'cliTabs:attach',
  select: 'cliTabs:select',
  state: 'cliTabs:state',
  close: 'cliTabs:close',
  minimize: 'cliTabs:minimize',
  maximize: 'cliTabs:maximize'
} as const

export type CliWindowMode = 'per-agent' | 'tabs'

export interface CliTabInfo {
  agentId: string
  title: string
  roleColor: string
}

export interface CliTabState {
  workspaceId: string
  tabs: CliTabInfo[]
  selectedAgentId: string | null
  maximized: boolean
  locale?: string
  theme?: 'dark' | 'light'
}

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
  /**
   * Frozen by the caller at Play. Omitted: frozen per workspaceId on first
   * create from `ui.cliWindowMode` (a later pref flip does not rewrite a
   * running workspace).
   */
  cliWindowMode?: CliWindowMode
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

interface CliTabSurface {
  agentId: string
  title: string
  roleColor: string
  webContents: WebContents
  view?: WebContentsView
  child?: BrowserWindow
}

interface CliChromeEntry {
  workspaceId: string
  window: BrowserWindow
  tabs: Map<string, CliTabSurface>
  selectedAgentId: string | null
  restoreBounds?: Rect
  /** First ready-to-show has not fired yet — startMinimized applies here. */
  awaitingFirstShow: boolean
}

const chromeWindows = new Map<string, CliChromeEntry>()
/** agentId → tab surface (authorization root in tabs mode). */
const tabByAgent = new Map<string, CliTabSurface & { workspaceId: string }>()
/** workspaceId → mode, frozen on first CLI create of that workspace. */
const frozenCliWindowMode = new Map<string, CliWindowMode>()
/**
 * First-create windows whose ready-to-show has not run. `focusCliWindow`
 * cancels startMinimized so an agent click before paint actually shows.
 */
const awaitingFirstShow = new Set<string>()
/**
 * layoutCliWindows ran for this agent after create and before ready-to-show.
 * Constructor bounds (planFor at create, often a 1-window tile) must not
 * overwrite that later layout when ready-to-show fires.
 */
const tiledSinceCreate = new Set<string>()
const focusRequested = new Set<string>()
const focusRequestedChrome = new Set<string>()
let tabIpcRegistered = false

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

export function workspaceChromeRoute(workspaceId: string): string {
  return `/workspace/${encodeURIComponent(workspaceId)}`
}

function readStartMinimized(): boolean {
  try {
    return getSettings().ui.startMinimized === true
  } catch {
    return false
  }
}

function readCliWindowMode(): CliWindowMode {
  try {
    return getSettings().ui.cliWindowMode === 'tabs' ? 'tabs' : 'per-agent'
  } catch {
    return 'per-agent'
  }
}

function readLocaleTheme(): { locale?: string; theme?: 'dark' | 'light' } {
  try {
    const ui = getSettings().ui
    return {
      ...(ui.locale ? { locale: ui.locale } : {}),
      ...(ui.theme ? { theme: ui.theme } : {})
    }
  } catch {
    return {}
  }
}

function resolveCliWindowMode(
  workspaceId: string | undefined,
  explicit?: CliWindowMode
): CliWindowMode {
  const key = workspaceId ?? ''
  if (explicit) {
    if (!frozenCliWindowMode.has(key)) frozenCliWindowMode.set(key, explicit)
    return frozenCliWindowMode.get(key) ?? explicit
  }
  const frozen = frozenCliWindowMode.get(key)
  if (frozen) return frozen
  const mode = readCliWindowMode()
  frozenCliWindowMode.set(key, mode)
  return mode
}

function webContentsViewAvailable(): boolean {
  return typeof WebContentsView === 'function'
}

/** The live registry entry, or null — a destroyed window is pruned on the way. */
function liveEntry(agentId: string): CliWindowEntry | null {
  const entry = windows.get(agentId)
  if (!entry) return null
  if (entry.window.isDestroyed()) {
    windows.delete(agentId)
    tiledSinceCreate.delete(agentId)
    return null
  }
  return entry
}

function liveChrome(workspaceId: string): CliChromeEntry | null {
  const entry = chromeWindows.get(workspaceId)
  if (!entry) return null
  if (entry.window.isDestroyed()) {
    forgetChrome(workspaceId)
    return null
  }
  return entry
}

function liveTab(agentId: string): (CliTabSurface & { workspaceId: string }) | null {
  const tab = tabByAgent.get(agentId)
  if (!tab) return null
  const chrome = liveChrome(tab.workspaceId)
  if (!chrome || !chrome.tabs.has(agentId)) {
    tabByAgent.delete(agentId)
    return null
  }
  if (tab.webContents.isDestroyed()) {
    chrome.tabs.delete(agentId)
    tabByAgent.delete(agentId)
    return null
  }
  return tab
}

export function getCliWindow(agentId: string): BrowserWindow | null {
  const tab = liveTab(agentId)
  if (tab) return liveChrome(tab.workspaceId)?.window ?? null
  return liveEntry(agentId)?.window ?? null
}

/**
 * The webContents that owns this agent's terminal IPC — the tab view (or
 * fallback child), never the workspace chrome.
 */
export function cliWebContents(agentId: string): WebContents | null {
  const tab = liveTab(agentId)
  if (tab) return tab.webContents
  const win = liveEntry(agentId)?.window
  if (!win || win.webContents.isDestroyed()) return null
  return win.webContents
}

export function listCliWindows(): { agentId: string; window: BrowserWindow }[] {
  const alive: { agentId: string; window: BrowserWindow }[] = []
  const seenAgents = new Set<string>()
  for (const [agentId, entry] of windows) {
    if (entry.window.isDestroyed()) windows.delete(agentId)
    else {
      seenAgents.add(agentId)
      alive.push({ agentId, window: entry.window })
    }
  }
  for (const [agentId] of tabByAgent) {
    if (seenAgents.has(agentId)) continue
    const tab = liveTab(agentId)
    const chrome = tab ? liveChrome(tab.workspaceId) : null
    if (!tab || !chrome) continue
    seenAgents.add(agentId)
    alive.push({ agentId, window: chrome.window })
  }
  return alive
}

/** Tab views only — chrome already appears in {@link listCliWindows}. */
export function listCliTabWebContents(): WebContents[] {
  const alive: WebContents[] = []
  for (const [agentId] of tabByAgent) {
    const tab = liveTab(agentId)
    if (tab && !tab.webContents.isDestroyed()) alive.push(tab.webContents)
  }
  return alive
}

/**
 * The single source of truth for "which agent is this renderer allowed to see".
 * Maps the VIEW (or per-agent window) webContents id, never the tab chrome.
 */
export function isCliWindowSender(webContentsId: number): string | null {
  for (const [agentId] of tabByAgent) {
    const tab = liveTab(agentId)
    if (tab && tab.webContents.id === webContentsId) return agentId
  }
  for (const [agentId, entry] of windows) {
    if (entry.window.isDestroyed()) {
      windows.delete(agentId)
      continue
    }
    if (entry.window.webContents.id === webContentsId) return agentId
  }
  return null
}

/** Chrome renderer of a tab workspace, or null. */
export function isWorkspaceChromeSender(webContentsId: number): string | null {
  for (const [workspaceId, entry] of chromeWindows) {
    if (entry.window.isDestroyed()) {
      forgetChrome(workspaceId)
      continue
    }
    if (entry.window.webContents.id === webContentsId) return workspaceId
  }
  return null
}

/** Frozen mode for this workspace, if a CLI has already been created. */
export function workspaceCliWindowMode(workspaceId: string): CliWindowMode | undefined {
  return frozenCliWindowMode.get(workspaceId)
}

export function workspaceUsesTabChrome(workspaceId: string): boolean {
  if (liveChrome(workspaceId)) return true
  return frozenCliWindowMode.get(workspaceId) === 'tabs'
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
    // Same grouping as planFor — omitted workspace ids group with each other.
    if (windowWorkspaceId(agentId) !== placement.workspaceId) continue
    const zones = windows.get(agentId)?.options.placement?.zones
    if (zones && zones.zones.length > 0) return zones
  }
  return undefined
}

function planFor(agentId: string, placement: CliWindowPlacement): PlacedWindow[] {
  const displays = currentDisplays()
  const existing: AgentWindowInfo[] = listCliWindows()
    .filter((entry) => entry.agentId !== agentId)
    .filter((entry) => liveTab(entry.agentId) === null)
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
    if (liveTab(agentId)) continue
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
 * The Vertragus window that currently has the OS keyboard, if any.
 * A focused CLI wins; otherwise a focused panel. `except` is the window
 * being reused so its own isFocused() does not look like a steal.
 */
function snapshotKeyboardWindow(except?: BrowserWindow): BrowserWindow | null {
  const seen = new Set<BrowserWindow>()
  for (const { window } of listCliWindows()) {
    if (window === except || seen.has(window)) continue
    seen.add(window)
    if (window.isFocused()) return window
  }
  const panel = getPanelWindow()
  if (panel?.isFocused()) return panel
  return null
}

/**
 * Spawn must not steal OS focus. Exception: Play — the panel is focused and
 * this is the first CLI of a run. A null snapshot means the user is in
 * another app: showInactive and do not focus.
 */
function shouldKeepKeyboard(previous: BrowserWindow | null, otherCliCount: number): boolean {
  if (!previous) return true
  const panel = getPanelWindow()
  if (previous === panel && otherCliCount === 0) return false
  return true
}

function restoreKeyboard(previous: BrowserWindow | null): void {
  if (previous && !previous.isDestroyed()) previous.focus()
}

/**
 * Snap these agents' CLI windows into their profile zones (or auto-tiles).
 * Only the first placement's workspace takes part — same grouping as
 * {@link planFor} (omitted workspace ids group with each other). Callers that
 * hold more than one workspace must use {@link layoutCliWindowsByWorkspace}
 * instead, or profile B's zones would shove profile A. Drops the
 * moved-by-user mark so a workspace click is a "go home", the same idea as
 * shrinking from maximize. Maximized windows are left alone. Bounds come from
 * the zone's `displayId`, not from where hide/show left the window.
 */
export function layoutCliWindows(agentIds: readonly string[]): void {
  if (agentIds.some((agentId) => liveTab(agentId) !== null)) return

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
    // Clear the user-drag pin so hide-all can send the window home. Do not
    // drop an in-flight programmatic grace — forgetWindowPlacement would, and
    // a delayed hide/show move would then rewrite zones onto the primary.
    forgetMovedByUser(entry.agentId)
    suppressMoveTracking(entry.agentId, undefined, SNAP_GRACE_MS)
  }

  const displays = currentDisplays()
  const rail = panelRail(displays)
  const zones = zonesForPlan(placement)
  const plan = planWindowLayout({
    ...(zones ? { profile: { zones } } : {}),
    displays,
    ...(rail ? { rail } : {}),
    windows: scoped.map((entry) =>
      toAgentWindowInfo(entry.agentId, entry.options.placement?.roleId ?? placement.roleId)
    )
  })

  for (const placed of plan) {
    if (isCliWindowMaximized(placed.agentId)) continue
    const win = getCliWindow(placed.agentId)
    if (!win) continue
    applyWindowBounds(placed.agentId, win, placed.bounds)
    rememberDisplay(placed.agentId, placed.bounds)
    tiledSinceCreate.add(placed.agentId)
  }
}

/**
 * {@link layoutCliWindows} once per tiling group. Hide-all restore of two
 * workspaces must not plan them together.
 */
export function layoutCliWindowsByWorkspace(agentIds: readonly string[]): void {
  const groups = new Map<string, string[]>()
  for (const agentId of agentIds) {
    if (!liveEntry(agentId)) continue
    const key = windowWorkspaceId(agentId) ?? ''
    const group = groups.get(key)
    if (group) group.push(agentId)
    else groups.set(key, [agentId])
  }
  for (const ids of groups.values()) layoutCliWindows(ids)
}

/**
 * Overlay save / display pick: running CLI windows of this workspace must
 * adopt the new layout so the next hide-all snap uses the saved screen, not
 * the copy captured when the window opened.
 */
export function applyCliWindowZones(workspaceId: string, zones: ZoneLayout): void {
  for (const { agentId } of listCliWindows()) {
    if (windowWorkspaceId(agentId) !== workspaceId) continue
    const entry = windows.get(agentId)
    const placement = entry?.options.placement
    if (!placement) continue
    entry.options.placement = { ...placement, zones }
  }
}

export function createCliWindow(agentId: string, options: CliWindowOptions): BrowserWindow {
  const existing = getCliWindow(agentId)
  if (existing) {
    if (liveTab(agentId)) {
      selectCliTab(agentId)
      return existing
    }
    const previous = snapshotKeyboardWindow(existing)
    const otherCliCount = listCliWindows().filter(({ window }) => window !== existing).length
    if (shouldKeepKeyboard(previous, otherCliCount)) {
      existing.showInactive()
      restoreKeyboard(previous)
    } else {
      existing.show()
      existing.focus()
    }
    return existing
  }

  const workspaceId = options.placement?.workspaceId
  const mode = resolveCliWindowMode(workspaceId, options.cliWindowMode)
  if (mode === 'tabs') {
    return ensureCliTab(agentId, options, workspaceId ?? '')
  }
  return createPerAgentWindow(agentId, options)
}

function createPerAgentWindow(agentId: string, options: CliWindowOptions): BrowserWindow {
  tiledSinceCreate.delete(agentId)
  const plan = options.bounds || !options.placement ? [] : planFor(agentId, options.placement)
  const placed = plan.find((entry) => entry.agentId === agentId)?.bounds
  const bounds = options.bounds ?? placed

  // Windows: new BrowserWindow() can steal OS focus before ready-to-show.
  const previous = snapshotKeyboardWindow()
  const keepKeyboard = shouldKeepKeyboard(previous, listCliWindows().length)

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
  if (keepKeyboard) restoreKeyboard(previous)
  secureWindow(win)
  loadRoute(win, `/agent/${encodeURIComponent(agentId)}`)
  awaitingFirstShow.add(agentId)
  win.on('ready-to-show', () => {
    if (keepKeyboard) {
      win.showInactive()
      restoreKeyboard(previous)
    } else {
      win.show()
    }
    // Constructor x/y is a hint. Linux compositors often ignore it until
    // after `show`; pinning here is what actually lands the window on the
    // target display. Skip when layoutCliWindows already tiled this agent
    // (reopen-all: constructor captured a 1-window plan).
    if (
      !tiledSinceCreate.has(agentId) &&
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
    tiledSinceCreate.delete(agentId)
    maybeMinimizeAfterFirstShow(agentId, win)
  })
  win.on('closed', () => {
    const entry = windows.get(agentId)
    if (entry?.window === win) windows.delete(agentId)
    awaitingFirstShow.delete(agentId)
    tiledSinceCreate.delete(agentId)
    focusRequested.delete(agentId)
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

function maybeMinimizeAfterFirstShow(agentId: string, win: BrowserWindow): void {
  const first = awaitingFirstShow.has(agentId)
  awaitingFirstShow.delete(agentId)
  if (!first || !readStartMinimized() || focusRequested.has(agentId)) return
  suppressMoveTracking(agentId)
  win.minimize()
}

function maybeMinimizeChromeAfterFirstShow(chrome: CliChromeEntry): void {
  const first = chrome.awaitingFirstShow
  chrome.awaitingFirstShow = false
  if (!first || !readStartMinimized() || focusRequestedChrome.has(chrome.workspaceId)) return
  const firstAgent = chrome.tabs.keys().next().value
  if (typeof firstAgent === 'string') suppressMoveTracking(firstAgent)
  chrome.window.minimize()
}

/** Close the window only — the agent process keeps running. */
export function closeCliWindow(agentId: string): void {
  const tab = liveTab(agentId)
  if (tab) {
    closeCliTab(agentId)
    return
  }
  const win = getCliWindow(agentId)
  windows.delete(agentId)
  tiledSinceCreate.delete(agentId)
  if (win) win.close()
}

/** Minimize the window — it stays in the registry and the agent keeps running. */
export function minimizeCliWindow(agentId: string): void {
  const win = getCliWindow(agentId)
  if (win) win.minimize()
}

/** Is this agent's window currently filling its screen? */
export function isCliWindowMaximized(agentId: string): boolean {
  const tab = liveTab(agentId)
  if (tab) return liveChrome(tab.workspaceId)?.restoreBounds !== undefined
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
  const tab = liveTab(agentId)
  if (tab) return toggleChromeMaximized(tab.workspaceId)

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
  focusRequested.add(agentId)
  const tab = liveTab(agentId)
  if (tab) focusRequestedChrome.add(tab.workspaceId)
  const win = getCliWindow(agentId)
  if (!win) return
  if (win.isMinimized()) {
    suppressMoveTracking(agentId)
    win.restore()
  }
  win.show()
  win.focus()
  if (tab) selectCliTab(agentId)
}

function forgetChrome(workspaceId: string): void {
  const entry = chromeWindows.get(workspaceId)
  if (!entry) return
  chromeWindows.delete(workspaceId)
  focusRequestedChrome.delete(workspaceId)
  for (const agentId of [...entry.tabs.keys()]) {
    destroyTabSurface(entry.window, entry.tabs.get(agentId))
    entry.tabs.delete(agentId)
    tabByAgent.delete(agentId)
    notifyClosed(agentId)
  }
}

function destroyTabSurface(parent: BrowserWindow | undefined, surface: CliTabSurface | undefined): void {
  if (!surface) return
  if (surface.view) {
    try {
      if (parent && !parent.isDestroyed()) parent.contentView.removeChildView(surface.view)
    } catch {
      // Parent may already be gone.
    }
    if (!surface.webContents.isDestroyed()) surface.webContents.close()
  }
  if (surface.child && !surface.child.isDestroyed()) {
    surface.child.close()
  }
}

function chromeTabState(chrome: CliChromeEntry): CliTabState {
  return {
    workspaceId: chrome.workspaceId,
    tabs: [...chrome.tabs.values()].map((tab) => ({
      agentId: tab.agentId,
      title: tab.title,
      roleColor: tab.roleColor
    })),
    selectedAgentId: chrome.selectedAgentId,
    maximized: chrome.restoreBounds !== undefined,
    ...readLocaleTheme()
  }
}

function pushTabState(chrome: CliChromeEntry): void {
  if (chrome.window.isDestroyed() || chrome.window.webContents.isDestroyed()) return
  chrome.window.webContents.send(CLI_TAB_CHANNELS.state, chromeTabState(chrome))
}

function tabContentRect(win: BrowserWindow): Rect {
  const bounds = win.getContentBounds()
  return {
    x: 0,
    y: CLI_TAB_STRIP_HEIGHT,
    width: bounds.width,
    height: Math.max(0, bounds.height - CLI_TAB_STRIP_HEIGHT)
  }
}

function childScreenRect(win: BrowserWindow): Rect {
  const bounds = win.getContentBounds()
  return {
    x: bounds.x,
    y: bounds.y + CLI_TAB_STRIP_HEIGHT,
    width: bounds.width,
    height: Math.max(0, bounds.height - CLI_TAB_STRIP_HEIGHT)
  }
}

function layoutTabSurfaces(chrome: CliChromeEntry): void {
  if (chrome.window.isDestroyed()) return
  const viewRect = tabContentRect(chrome.window)
  const childRect = childScreenRect(chrome.window)
  for (const [agentId, surface] of chrome.tabs) {
    const selected = chrome.selectedAgentId === agentId
    if (surface.view) {
      surface.view.setBounds(viewRect)
      surface.view.setVisible(selected)
    }
    if (surface.child && !surface.child.isDestroyed()) {
      surface.child.setBounds(childRect)
      if (selected) surface.child.showInactive()
      else surface.child.hide()
    }
  }
}

function showTab(chrome: CliChromeEntry, agentId: string): void {
  chrome.selectedAgentId = agentId
  const surface = chrome.tabs.get(agentId)
  if (surface) chrome.window.setTitle(cliWindowTitle(surface.title))
  layoutTabSurfaces(chrome)
  pushTabState(chrome)
}

/** Select this agent's tab. Agent must already belong to a chrome window. */
export function selectCliTab(agentId: string): boolean {
  const tab = liveTab(agentId)
  if (!tab) return false
  const chrome = liveChrome(tab.workspaceId)
  if (!chrome) return false
  showTab(chrome, agentId)
  return true
}

/**
 * Tab click from chrome: agent must belong to THIS workspace.
 * Returns false when the sender or agent is wrong (no throw — a send).
 */
export function selectCliTabInWorkspace(workspaceId: string, agentId: string): boolean {
  const tab = liveTab(agentId)
  if (!tab || tab.workspaceId !== workspaceId) return false
  return selectCliTab(agentId)
}

function closeCliTab(agentId: string): void {
  const tab = liveTab(agentId)
  if (!tab) return
  const chrome = liveChrome(tab.workspaceId)
  if (!chrome) return
  const surface = chrome.tabs.get(agentId)
  chrome.tabs.delete(agentId)
  tabByAgent.delete(agentId)
  destroyTabSurface(chrome.window, surface)
  notifyClosed(agentId)
  if (chrome.tabs.size === 0) {
    chromeWindows.delete(tab.workspaceId)
    focusRequestedChrome.delete(tab.workspaceId)
    if (!chrome.window.isDestroyed()) chrome.window.close()
    return
  }
  if (chrome.selectedAgentId === agentId) {
    const next = chrome.tabs.keys().next().value
    if (typeof next === 'string') showTab(chrome, next)
    else pushTabState(chrome)
  } else {
    layoutTabSurfaces(chrome)
    pushTabState(chrome)
  }
}

function closeChromeWindow(workspaceId: string): void {
  const chrome = liveChrome(workspaceId)
  if (!chrome) return
  chromeWindows.delete(workspaceId)
  focusRequestedChrome.delete(workspaceId)
  const agentIds = [...chrome.tabs.keys()]
  for (const agentId of agentIds) {
    const surface = chrome.tabs.get(agentId)
    chrome.tabs.delete(agentId)
    tabByAgent.delete(agentId)
    destroyTabSurface(chrome.window, surface)
    notifyClosed(agentId)
  }
  if (!chrome.window.isDestroyed()) chrome.window.close()
}

function toggleChromeMaximized(workspaceId: string): boolean {
  const chrome = liveChrome(workspaceId)
  if (!chrome) return false
  const win = chrome.window
  const agentId = chrome.selectedAgentId ?? [...chrome.tabs.keys()][0]
  if (chrome.restoreBounds) {
    const target = chrome.restoreBounds
    delete chrome.restoreBounds
    if (agentId) applyWindowBounds(agentId, win, target)
    else win.setBounds(target)
    layoutTabSurfaces(chrome)
    pushTabState(chrome)
    return false
  }
  const bounds = win.getBounds()
  const displays = currentDisplays()
  const host = displayFor(bounds, displays) ?? displays.find((display) => display.primary)
  if (!host) return false
  chrome.restoreBounds = bounds
  if (agentId) applyWindowBounds(agentId, win, host.workArea)
  else win.setBounds(host.workArea)
  layoutTabSurfaces(chrome)
  pushTabState(chrome)
  return true
}

function createTabSurface(
  chrome: CliChromeEntry,
  agentId: string,
  options: CliWindowOptions
): CliTabSurface {
  if (webContentsViewAvailable()) {
    const view = new WebContentsView({ webPreferences: baseWebPreferences() })
    secureWebContents(view.webContents)
    loadContentsRoute(view.webContents, `/agent/${encodeURIComponent(agentId)}`)
    chrome.window.contentView.addChildView(view)
    return {
      agentId,
      title: options.title,
      roleColor: options.roleColor,
      webContents: view.webContents,
      view
    }
  }
  const child = new BrowserWindow({
    ...glassWindowOptions(),
    parent: chrome.window,
    skipTaskbar: true,
    width: CLI_DEFAULT_WIDTH,
    height: CLI_DEFAULT_HEIGHT,
    minWidth: CLI_MIN_WIDTH,
    minHeight: CLI_MIN_HEIGHT,
    resizable: true,
    maximizable: false,
    alwaysOnTop: false,
    title: cliWindowTitle(options.title)
  })
  secureWindow(child)
  loadRoute(child, `/agent/${encodeURIComponent(agentId)}`)
  child.on('closed', () => {
    if (liveTab(agentId)?.child === child) closeCliTab(agentId)
  })
  return {
    agentId,
    title: options.title,
    roleColor: options.roleColor,
    webContents: child.webContents,
    child
  }
}

function createChromeWindow(workspaceId: string, options: CliWindowOptions): CliChromeEntry {
  const keepKeyboard = listCliWindows().some(({ window }) => window.isFocused())
  const win = new BrowserWindow({
    ...glassWindowOptions(),
    width: CLI_CHROME_WIDTH,
    height: CLI_CHROME_HEIGHT,
    minWidth: CLI_MIN_WIDTH,
    minHeight: CLI_MIN_HEIGHT,
    resizable: true,
    maximizable: false,
    alwaysOnTop: false,
    title: cliWindowTitle(options.title)
  })
  secureWindow(win)
  loadRoute(win, workspaceChromeRoute(workspaceId))
  const chrome: CliChromeEntry = {
    workspaceId,
    window: win,
    tabs: new Map(),
    selectedAgentId: null,
    awaitingFirstShow: true
  }
  chromeWindows.set(workspaceId, chrome)
  win.on('ready-to-show', () => {
    if (keepKeyboard) win.showInactive()
    else win.show()
    maybeMinimizeChromeAfterFirstShow(chrome)
    layoutTabSurfaces(chrome)
  })
  win.on('resize', () => layoutTabSurfaces(chrome))
  win.on('move', () => layoutTabSurfaces(chrome))
  win.on('closed', () => {
    const entry = chromeWindows.get(workspaceId)
    if (entry?.window !== win) return
    forgetChrome(workspaceId)
  })
  return chrome
}

function ensureCliTab(
  agentId: string,
  options: CliWindowOptions,
  workspaceId: string
): BrowserWindow {
  const existingTab = liveTab(agentId)
  if (existingTab) {
    const chrome = liveChrome(existingTab.workspaceId)
    if (chrome) {
      selectCliTab(agentId)
      return chrome.window
    }
  }

  let chrome = liveChrome(workspaceId)
  if (!chrome) chrome = createChromeWindow(workspaceId, options)

  const surface = createTabSurface(chrome, agentId, options)
  chrome.tabs.set(agentId, surface)
  tabByAgent.set(agentId, { ...surface, workspaceId })
  if (!chrome.selectedAgentId) showTab(chrome, agentId)
  else {
    layoutTabSurfaces(chrome)
    pushTabState(chrome)
  }
  return chrome.window
}

function payloadAgentId(payload: unknown): string | undefined {
  if (typeof payload === 'string') return payload
  if (payload && typeof payload === 'object' && 'agentId' in payload) {
    const agentId = (payload as { agentId?: unknown }).agentId
    return typeof agentId === 'string' ? agentId : undefined
  }
  return undefined
}

/** Host channels for the workspace tab chrome. Idempotent. */
export function registerCliTabIpc(): void {
  if (tabIpcRegistered) return
  tabIpcRegistered = true

  ipcMain.handle(
    CLI_TAB_CHANNELS.attach,
    (event: { sender: { id: number } }, payload?: unknown): CliTabState => {
      const workspaceId = isWorkspaceChromeSender(event.sender.id)
      if (!workspaceId) {
        throw new Error('cliTabs:attach rejected — sender is not a workspace chrome window')
      }
      const claimed =
        typeof payload === 'string'
          ? payload
          : (payload as { workspaceId?: string } | undefined)?.workspaceId
      if (claimed && claimed !== workspaceId) {
        throw new Error('cliTabs:attach rejected — window may only attach to its own workspace')
      }
      const chrome = liveChrome(workspaceId)
      if (!chrome) {
        return {
          workspaceId,
          tabs: [],
          selectedAgentId: null,
          maximized: false,
          ...readLocaleTheme()
        }
      }
      return chromeTabState(chrome)
    }
  )

  ipcMain.on(
    CLI_TAB_CHANNELS.select,
    (event: { sender: { id: number } }, payload?: unknown): void => {
      const workspaceId = isWorkspaceChromeSender(event.sender.id)
      if (!workspaceId) return
      const agentId = payloadAgentId(payload)
      if (!agentId) return
      selectCliTabInWorkspace(workspaceId, agentId)
    }
  )

  ipcMain.on(CLI_TAB_CHANNELS.close, (event: { sender: { id: number } }): void => {
    const workspaceId = isWorkspaceChromeSender(event.sender.id)
    if (!workspaceId) return
    closeChromeWindow(workspaceId)
  })

  ipcMain.on(CLI_TAB_CHANNELS.minimize, (event: { sender: { id: number } }): void => {
    const workspaceId = isWorkspaceChromeSender(event.sender.id)
    if (!workspaceId) return
    const chrome = liveChrome(workspaceId)
    chrome?.window.minimize()
  })

  ipcMain.handle(CLI_TAB_CHANNELS.maximize, (event: { sender: { id: number } }): boolean => {
    const workspaceId = isWorkspaceChromeSender(event.sender.id)
    if (!workspaceId) return false
    return toggleChromeMaximized(workspaceId)
  })
}
