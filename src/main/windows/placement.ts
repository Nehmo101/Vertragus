/**
 * Where an agent's CLI window opens — zones first, auto-tiling as the fallback.
 *
 * Three rules the layout obeys, in this order:
 *
 * 1. **A zone wins.** If the profile has a zone for the agent's role AND the
 *    display that zone was drawn on is currently attached, the window goes
 *    there. Several agents of the same role share that zone as a mini grid
 *    (`computeTiles` with the zone rect as its work area), so a second reviewer
 *    does not land exactly on top of the first one.
 * 2. **No zone → auto-tiling across every display.** Displays are filled in
 *    order (primary first, then by area descending) up to a *comfortable*
 *    capacity — not up to the minimum-size capacity, which would cram twelve
 *    terminals onto the primary monitor while a second one stays empty. The
 *    orchestrator is sorted to the front and handed to `computeTiles` as its
 *    `primaryIndex`, so it gets the largest cell on the first display.
 * 3. **A window the user moved is never touched again — unless live reflow is
 *    on.** With `ui.reflowNeighbors` off, a drag pins the window (`movedByUser`)
 *    and neighbors stay put until the next `start_agent`. With it on, the same
 *    gesture reflows neighbors on that display and rewrites their zones instead
 *    of pinning. Cross-display drags still pin the window that left.
 *
 * Electron-free on purpose: displays, windows and bounds all come in as plain
 * data, so every rule above is a pure unit test with fake monitors. The only
 * stateful part is the moved-by-user registry, and it is fed through a minimal
 * window interface the tests can fake as well.
 */
import { reflowNeighbors } from '@shared/layout/reflow'
import { ORCHESTRATOR_ROLE_ID } from '@shared/prompts/roles'
import {
  absToRelRect,
  resolveZoneRect,
  zonesForRole,
  type Zone,
  type ZoneLayout
} from '@shared/schema/zones'
import { availableArea, computeTiles, type Rect } from './tiling'

export type { Rect }

/** A monitor as the placement layer sees it (Electron `Display`, narrowed). */
export interface DisplayInfo {
  id: number
  workArea: Rect
  /** True for `screen.getPrimaryDisplay()`. The orchestrator lives here. */
  primary?: boolean
}

/** The panel strip that auto-tiling keeps clear, on the display it is docked to. */
export interface RailInfo {
  displayId: number
  edge: 'left' | 'right'
  width: number
}

/** One agent window taking part in (or opting out of) the layout. */
export interface AgentWindowInfo {
  agentId: string
  /** Role key; the orchestrator uses {@link ORCHESTRATOR_ROLE_ID}. */
  roleId: string
  /** True once the user dragged or resized it — then it is left alone forever. */
  movedByUser?: boolean
}

export interface PlacedWindow {
  agentId: string
  bounds: Rect
}

/** Only the part of a profile this layer reads. */
export interface PlacementProfile {
  zones?: ZoneLayout
}

export interface PlanWindowLayoutInput {
  profile?: PlacementProfile
  displays: readonly DisplayInfo[]
  windows: readonly AgentWindowInfo[]
  rail?: RailInfo
}

/** Smallest useful terminal inside a hand-drawn zone — zones are often small. */
export const ZONE_MIN_WIDTH = 380
export const ZONE_MIN_HEIGHT = 260
/** Mirrors CLI_MIN_WIDTH/HEIGHT; duplicated to keep this module import-free. */
export const AUTO_MIN_WIDTH = 420
export const AUTO_MIN_HEIGHT = 300
/**
 * Tile size a display is considered "full" at. Bigger than the minimum on
 * purpose: capacity decides when tiling spills onto the next monitor, and a
 * capacity computed from the minimum would never spill.
 */
export const COMFORT_WIDTH = 760
export const COMFORT_HEIGHT = 480

/** Key used for the window that is about to be created and has no id yet. */
export const NEW_AGENT_KEY = '__new__'

const FALLBACK_RECT: Rect = { x: 0, y: 0, width: COMFORT_WIDTH, height: COMFORT_HEIGHT }

export function rectsEqual(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

/**
 * The display a window sits on, by its center point. Shared by auto-tiling,
 * grow/shrink and live reflow so a window never "belongs" to two monitors.
 */
export function displayFor(bounds: Rect, displays: readonly DisplayInfo[]): DisplayInfo | undefined {
  const centerX = bounds.x + bounds.width / 2
  const centerY = bounds.y + bounds.height / 2
  return displays.find(
    ({ workArea }) =>
      centerX >= workArea.x &&
      centerX < workArea.x + workArea.width &&
      centerY >= workArea.y &&
      centerY < workArea.y + workArea.height
  )
}

function areaOf(rect: Rect): number {
  return Math.max(0, rect.width) * Math.max(0, rect.height)
}

/** Primary first, then the biggest monitor; id breaks ties so plans are stable. */
function displayOrder(displays: readonly DisplayInfo[]): DisplayInfo[] {
  return [...displays].sort((a, b) => {
    if (Boolean(a.primary) !== Boolean(b.primary)) return a.primary ? -1 : 1
    const byArea = areaOf(b.workArea) - areaOf(a.workArea)
    return byArea !== 0 ? byArea : a.id - b.id
  })
}

function railFor(display: DisplayInfo, rail: RailInfo | undefined): RailInfo | undefined {
  return rail && rail.displayId === display.id ? rail : undefined
}

/** How many comfortable tiles fit on this display, at least one. */
function comfortCapacity(display: DisplayInfo, rail: RailInfo | undefined): number {
  const own = railFor(display, rail)
  const area = availableArea(display.workArea, own?.edge, own?.width ?? 0)
  const cols = Math.floor(area.width / COMFORT_WIDTH)
  const rows = Math.floor(area.height / COMFORT_HEIGHT)
  return Math.max(1, cols * rows)
}

/** Every zone of this role whose display is currently attached, in layout order. */
function resolvableZones(
  layout: ZoneLayout | undefined,
  roleId: string,
  displays: readonly DisplayInfo[]
): Rect[] {
  const rects: Rect[] = []
  for (const zone of zonesForRole(layout, roleId)) {
    const rect = resolveZoneRect(zone, displays)
    if (rect) rects.push(rect)
  }
  return rects
}

/**
 * The full layout for a set of agent windows: every window that is not
 * `movedByUser` gets a rect, in the order it was passed in.
 *
 * Callers use this for BOTH jobs at once — the bounds of the window they are
 * about to open and the re-tiling of the windows already on screen — because
 * those two answers must come from the same computation or they contradict
 * each other.
 */
export function planWindowLayout(input: PlanWindowLayoutInput): PlacedWindow[] {
  const participants = input.windows.filter((window) => !window.movedByUser)
  if (participants.length === 0 || input.displays.length === 0) return []

  const layout = input.profile?.zones
  const placements = new Map<string, Rect>()

  // --- zoned roles: one mini grid per zone ---------------------------------
  const zoneless: AgentWindowInfo[] = []
  const byRole = new Map<string, AgentWindowInfo[]>()
  for (const window of participants) {
    const group = byRole.get(window.roleId)
    if (group) group.push(window)
    else byRole.set(window.roleId, [window])
  }

  for (const [roleId, members] of byRole) {
    const zones = resolvableZones(layout, roleId, input.displays)
    if (zones.length === 0) {
      zoneless.push(...members)
      continue
    }
    // Several zones for one role (e.g. one per monitor): spread the agents
    // round-robin, then tile inside each zone.
    const perZone: AgentWindowInfo[][] = zones.map(() => [])
    members.forEach((member, index) => perZone[index % zones.length]!.push(member))
    zones.forEach((zone, zoneIndex) => {
      const occupants = perZone[zoneIndex]!
      if (occupants.length === 0) return
      const tiles = computeTiles({
        workArea: zone,
        railWidth: 0,
        count: occupants.length,
        minW: ZONE_MIN_WIDTH,
        minH: ZONE_MIN_HEIGHT
      })
      occupants.forEach((occupant, index) => {
        placements.set(occupant.agentId, tiles[index] ?? zone)
      })
    })
  }

  // --- everything else: auto-tiling across the displays --------------------
  if (zoneless.length > 0) {
    // The orchestrator goes first so it lands on the first display as cell 0.
    const ordered = [
      ...zoneless.filter((window) => window.roleId === ORCHESTRATOR_ROLE_ID),
      ...zoneless.filter((window) => window.roleId !== ORCHESTRATOR_ROLE_ID)
    ]
    const displays = displayOrder(input.displays)
    let cursor = 0
    displays.forEach((display, displayIndex) => {
      if (cursor >= ordered.length) return
      const last = displayIndex === displays.length - 1
      const take = last
        ? ordered.length - cursor
        : Math.min(comfortCapacity(display, input.rail), ordered.length - cursor)
      if (take <= 0) return
      const occupants = ordered.slice(cursor, cursor + take)
      cursor += take
      const own = railFor(display, input.rail)
      const tiles = computeTiles({
        workArea: display.workArea,
        ...(own ? { railEdge: own.edge } : {}),
        railWidth: own?.width ?? 0,
        count: occupants.length,
        minW: AUTO_MIN_WIDTH,
        minH: AUTO_MIN_HEIGHT,
        primaryIndex: 0
      })
      occupants.forEach((occupant, index) => {
        placements.set(occupant.agentId, tiles[index] ?? display.workArea)
      })
    })
  }

  return participants.map((window) => ({
    agentId: window.agentId,
    bounds: placements.get(window.agentId) ?? FALLBACK_RECT
  }))
}

export interface PlaceAgentWindowInput {
  profile?: PlacementProfile
  roleId: string
  /** Id of the window being opened; defaults to {@link NEW_AGENT_KEY}. */
  agentId?: string
  displays: readonly DisplayInfo[]
  /** The agent windows already on screen — moved ones are ignored. */
  existingWindows?: readonly AgentWindowInfo[]
  rail?: RailInfo
}

/**
 * Bounds for ONE window that is about to open. Convenience wrapper around
 * {@link planWindowLayout}; use the plan itself when the already-open windows
 * should be re-tiled too.
 */
export function placeAgentWindow(input: PlaceAgentWindowInput): Rect {
  const agentId = input.agentId ?? NEW_AGENT_KEY
  const plan = planWindowLayout({
    ...(input.profile ? { profile: input.profile } : {}),
    displays: input.displays,
    ...(input.rail ? { rail: input.rail } : {}),
    windows: [
      ...(input.existingWindows ?? []).filter((window) => window.agentId !== agentId),
      { agentId, roleId: input.roleId }
    ]
  })
  return plan.find((entry) => entry.agentId === agentId)?.bounds ?? FALLBACK_RECT
}

// --- live neighbor reflow ------------------------------------------------

/** Settle delay after the last user move/resize before neighbors are laid out. */
export const REFLOW_DEBOUNCE_MS = 80

/** One live CLI window as the reflow layer sees it. */
export interface LiveWindowInfo {
  agentId: string
  roleId: string
  bounds: Rect
  maximized?: boolean
}

export interface PlanLiveReflowInput {
  windows: readonly LiveWindowInfo[]
  movedId: string
  nextRect: Rect
  /** Display the gesture window sat on before this gesture. */
  previousDisplayId: number
  displays: readonly DisplayInfo[]
  rail?: RailInfo
  minWidth?: number
  minHeight?: number
  /** Current profile layout; unused overlay zones survive a live reflow. */
  existingZones?: ZoneLayout
}

export interface LiveReflowPlan {
  placements: PlacedWindow[]
  /** Gesture window, when it left its display — neighbors on the origin fill. */
  markMoved: string[]
  zones: ZoneLayout
}

function workAreaMinusRail(display: DisplayInfo, rail: RailInfo | undefined): Rect {
  const own = rail && rail.displayId === display.id ? rail : undefined
  return availableArea(display.workArea, own?.edge, own?.width ?? 0)
}

function zoneLayoutFromWindows(
  windows: readonly LiveWindowInfo[],
  displays: readonly DisplayInfo[]
): ZoneLayout {
  const zones: Zone[] = []
  for (const window of windows) {
    if (!window.roleId) continue
    const display = displayFor(window.bounds, displays)
    if (!display) continue
    zones.push({
      roleId: window.roleId,
      displayId: display.id,
      rect: absToRelRect(window.bounds, display.workArea)
    })
  }
  return { zones }
}

function zoneRoleDisplayKey(zone: Pick<Zone, 'roleId' | 'displayId'>): string {
  return `${zone.roleId}\0${String(zone.displayId)}`
}

/**
 * Keep overlay zones that no live window occupies on a reflowed display.
 * Live windows replace only the matching (roleId, displayId) pairs there.
 */
export function mergeLiveReflowZones(
  existing: ZoneLayout | undefined,
  live: ZoneLayout,
  reflowedDisplayIds: readonly number[]
): ZoneLayout {
  const reflowed = new Set(reflowedDisplayIds)
  const incoming = live.zones.filter((zone) => reflowed.has(zone.displayId))
  const taken = new Set(incoming.map(zoneRoleDisplayKey))
  const kept = (existing?.zones ?? []).filter((zone) => !taken.has(zoneRoleDisplayKey(zone)))
  return { zones: [...kept, ...incoming] }
}

function withPlacements(
  windows: readonly LiveWindowInfo[],
  placements: readonly PlacedWindow[],
  extras: ReadonlyMap<string, Rect>
): LiveWindowInfo[] {
  const byId = new Map(placements.map((entry) => [entry.agentId, entry.bounds]))
  for (const [agentId, bounds] of extras) byId.set(agentId, bounds)
  return windows.map((window) => {
    const bounds = byId.get(window.agentId)
    return bounds ? { ...window, bounds } : window
  })
}

function participantsOn(
  windows: readonly LiveWindowInfo[],
  displayId: number,
  displays: readonly DisplayInfo[],
  movedId: string,
  movedRect: Rect
): LiveWindowInfo[] {
  return windows.filter((window) => {
    if (window.maximized) return false
    const bounds = window.agentId === movedId ? movedRect : window.bounds
    return displayFor(bounds, displays)?.id === displayId
  })
}

function expandRemainder(
  remainder: readonly LiveWindowInfo[],
  bounds: Rect,
  minWidth: number,
  minHeight: number
): PlacedWindow[] {
  if (remainder.length === 0) return []
  if (remainder.length === 1) {
    const only = remainder[0]!
    return reflowNeighbors({
      rects: [{ id: only.agentId, rect: only.bounds }],
      movedId: only.agentId,
      nextRect: bounds,
      bounds,
      minWidth,
      minHeight
    }).map((item) => ({ agentId: item.id, bounds: item.rect }))
  }

  let items = remainder.map((window) => ({ id: window.agentId, rect: window.bounds }))
  for (const window of remainder) {
    const current = items.find((item) => item.id === window.agentId)
    if (!current) continue
    items = reflowNeighbors({
      rects: items,
      movedId: window.agentId,
      nextRect: current.rect,
      bounds,
      minWidth,
      minHeight
    })
  }
  return items.map((item) => ({ agentId: item.id, bounds: item.rect }))
}

/**
 * Layout after a user drag/resize: neighbors on the same display shrink and
 * fill the gap. Maximized windows are skipped. A window whose center has moved
 * to another display is dropped from the set (and marked moved) so the rest
 * can reclaim the origin work area.
 */
export function planLiveReflow(input: PlanLiveReflowInput): LiveReflowPlan | null {
  const moved = input.windows.find((window) => window.agentId === input.movedId)
  if (!moved || moved.maximized) return null

  const minWidth = input.minWidth ?? AUTO_MIN_WIDTH
  const minHeight = input.minHeight ?? AUTO_MIN_HEIGHT
  const previousDisplay = input.displays.find((display) => display.id === input.previousDisplayId)
  if (!previousDisplay) return null

  const nextRect = input.nextRect
  const currentDisplay = displayFor(nextRect, input.displays)
  const crossed = currentDisplay === undefined || currentDisplay.id !== previousDisplay.id

  if (crossed) {
    const remainder = participantsOn(
      input.windows,
      previousDisplay.id,
      input.displays,
      input.movedId,
      moved.bounds
    ).filter((window) => window.agentId !== input.movedId)
    const placements = expandRemainder(
      remainder,
      workAreaMinusRail(previousDisplay, input.rail),
      minWidth,
      minHeight
    )
    return {
      placements,
      markMoved: [input.movedId],
      zones: mergeLiveReflowZones(
        input.existingZones,
        zoneLayoutFromWindows(
          withPlacements(input.windows, placements, new Map([[input.movedId, nextRect]])),
          input.displays
        ),
        [previousDisplay.id]
      )
    }
  }

  const participants = participantsOn(
    input.windows,
    currentDisplay.id,
    input.displays,
    input.movedId,
    nextRect
  )
  if (participants.length === 0) return null

  const laidOut = reflowNeighbors({
    rects: participants.map((window) => ({
      id: window.agentId,
      rect: window.agentId === input.movedId ? moved.bounds : window.bounds
    })),
    movedId: input.movedId,
    nextRect,
    bounds: workAreaMinusRail(currentDisplay, input.rail),
    minWidth,
    minHeight
  })
  const placements = laidOut.map((item) => ({ agentId: item.id, bounds: item.rect }))
  return {
    placements,
    markMoved: [],
    zones: mergeLiveReflowZones(
      input.existingZones,
      zoneLayoutFromWindows(withPlacements(input.windows, placements, new Map()), input.displays),
      [currentDisplay.id]
    )
  }
}

// --- moved-by-user registry ----------------------------------------------

/** The slice of a BrowserWindow this module needs. Faked wholesale in tests. */
export interface MovableWindow {
  on(event: 'move' | 'resize', handler: () => void): unknown
  setBounds(bounds: Rect): void
  isDestroyed?(): boolean
}

/**
 * How long after a programmatic `setBounds` a `move`/`resize` event is still
 * assumed to be ours. Windows fires those asynchronously (and more than once
 * during an animated move), so a boolean flag cleared on the next tick would
 * mark our own tiling as a user drag.
 */
export const PROGRAMMATIC_GRACE_MS = 800

const movedByUser = new Set<string>()
const programmaticUntil = new Map<string, number>()
/** Read at event time, never captured, so a test can travel in time mid-run. */
let clock: () => number = () => Date.now()
/** True while tests drive `clock` — debounce is flushed, not a real timer. */
let testClock = false

let reflowNeighborsGetter: () => boolean = () => false
let liveReflowHandler: ((agentId: string) => void) | undefined
let pendingReflowId: string | undefined
let pendingReflowAt = 0
let reflowTimer: ReturnType<typeof setTimeout> | undefined

/** Test / production seam. Placement never reads the settings store itself. */
export function setReflowNeighborsGetter(getter: () => boolean): void {
  reflowNeighborsGetter = getter
}

export function reflowNeighborsEnabled(): boolean {
  return reflowNeighborsGetter()
}

/** cliWindow registers the Electron-side apply/persist; tests inject a spy. */
export function setLiveReflowHandler(handler: ((agentId: string) => void) | undefined): void {
  liveReflowHandler = handler
}

function clearReflowTimer(): void {
  if (reflowTimer !== undefined) clearTimeout(reflowTimer)
  reflowTimer = undefined
}

function scheduleLiveReflow(agentId: string): void {
  pendingReflowId = agentId
  pendingReflowAt = clock() + REFLOW_DEBOUNCE_MS
  clearReflowTimer()
  if (testClock) return
  reflowTimer = setTimeout(() => {
    reflowTimer = undefined
    flushLiveReflow()
  }, REFLOW_DEBOUNCE_MS)
}

/** Run a due live reflow. Tests advance the placement clock, then call this. */
export function flushLiveReflow(nowMs?: number): void {
  if (pendingReflowId === undefined) return
  if ((nowMs ?? clock()) < pendingReflowAt) return
  const agentId = pendingReflowId
  pendingReflowId = undefined
  pendingReflowAt = 0
  clearReflowTimer()
  liveReflowHandler?.(agentId)
}

export function isMovedByUser(agentId: string): boolean {
  return movedByUser.has(agentId)
}

export function markMovedByUser(agentId: string): void {
  movedByUser.add(agentId)
}

/** Drop a closed window's bookkeeping so a reopened agent tiles again. */
export function forgetWindowPlacement(agentId: string): void {
  movedByUser.delete(agentId)
  programmaticUntil.delete(agentId)
  if (pendingReflowId === agentId) {
    pendingReflowId = undefined
    pendingReflowAt = 0
    clearReflowTimer()
  }
}

/** Ignore move/resize events for this window for the next grace period. */
export function suppressMoveTracking(agentId: string, now?: () => number): void {
  programmaticUntil.set(agentId, (now ?? clock)() + PROGRAMMATIC_GRACE_MS)
}

/**
 * Start watching a window for user moves. The guard against our own
 * `setBounds` is time-based (see {@link PROGRAMMATIC_GRACE_MS}); the initial
 * placement is suppressed here as well, because showing a window at its
 * constructor bounds already emits a `move` on some platforms.
 */
export function trackWindowMoves(
  agentId: string,
  win: MovableWindow,
  now?: () => number,
  onUserMoved?: () => void
): void {
  suppressMoveTracking(agentId, now)
  const onUserGesture = (): void => {
    if ((now ?? clock)() < (programmaticUntil.get(agentId) ?? 0)) return
    if (reflowNeighborsGetter()) {
      scheduleLiveReflow(agentId)
      return
    }
    movedByUser.add(agentId)
    onUserMoved?.()
  }
  win.on('move', onUserGesture)
  win.on('resize', onUserGesture)
}

/** Move a window we own — guarded, so the change is not read back as a drag. */
export function applyWindowBounds(
  agentId: string,
  win: MovableWindow,
  bounds: Rect,
  now?: () => number
): void {
  if (win.isDestroyed?.()) return
  suppressMoveTracking(agentId, now)
  win.setBounds(bounds)
}

/** Test seam — the registry is module state by design (it outlives windows). */
export function resetPlacementStateForTesting(clockForTesting?: () => number): void {
  movedByUser.clear()
  programmaticUntil.clear()
  pendingReflowId = undefined
  pendingReflowAt = 0
  clearReflowTimer()
  reflowNeighborsGetter = (): boolean => false
  liveReflowHandler = undefined
  clock = clockForTesting ?? ((): number => Date.now())
  testClock = clockForTesting !== undefined
}
