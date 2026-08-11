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
 * 3. **A window the user moved is never touched again.** Manual placement is a
 *    decision, and silently undoing it on the next `start_agent` is the single
 *    most infuriating thing a tiling layer can do. Moved windows drop out of
 *    the layout entirely (they also do not consume a cell — they are simply not
 *    part of the tiling any more).
 *
 * Electron-free on purpose: displays, windows and bounds all come in as plain
 * data, so every rule above is a pure unit test with fake monitors. The only
 * stateful part is the moved-by-user registry, and it is fed through a minimal
 * window interface the tests can fake as well.
 */
import { ORCHESTRATOR_ROLE_ID } from '@shared/prompts/roles'
import { resolveZoneRect, zonesForRole, type ZoneLayout } from '@shared/schema/zones'
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
export function trackWindowMoves(agentId: string, win: MovableWindow, now?: () => number): void {
  suppressMoveTracking(agentId, now)
  const onUserGesture = (): void => {
    if ((now ?? clock)() < (programmaticUntil.get(agentId) ?? 0)) return
    movedByUser.add(agentId)
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
  clock = clockForTesting ?? ((): number => Date.now())
}
