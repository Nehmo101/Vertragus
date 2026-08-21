/**
 * Navigation state that must survive a trip into a terminal, a reload, or a
 * reconnect — kept here as plain functions so the parts that can silently
 * lose the user's place are the parts a unit test holds.
 *
 * The defect this module exists for: `App` used to early-return the terminal,
 * which unmounted the whole overview. That threw away three things at once —
 * the document scroll offset, every card's open/closed state, and any
 * half-typed answer. The fix keeps the overview mounted underneath the
 * terminal's fixed overlay (see `App.tsx`); what stays here is the
 * bookkeeping that fix still needs: the history entry that makes the hardware
 * back button close the terminal, the drift check for the one case where the
 * document scrolled anyway, and the expansion map that must also outlive a
 * reload.
 */
import type { RemotePhase } from './useRemote'

// --- storage -------------------------------------------------------------

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/**
 * Safari in private mode throws on the `localStorage` *property access*, not
 * only on the call, and a home-screen bookmark can be opened in a profile
 * that has site data switched off entirely. Everything downstream therefore
 * has to work with no storage at all: a phone that cannot remember which
 * cards were open is still a working phone.
 */
export function browserStorage(): StorageLike | undefined {
  try {
    return window.localStorage ?? undefined
  } catch {
    return undefined
  }
}

export function readStored(key: string, storage = browserStorage()): string | undefined {
  try {
    return storage?.getItem(key) ?? undefined
  } catch {
    return undefined
  }
}

export function writeStored(key: string, value: string, storage = browserStorage()): void {
  try {
    storage?.setItem(key, value)
  } catch {
    /* A full or read-only quota must not take the screen down with it. */
  }
}

// --- card expansion ------------------------------------------------------

export const EXPANSION_KEY = 'vertragus.remote.expanded'

/**
 * Hostile or stale JSON yields an empty map rather than a throw: the value is
 * written by an older build of this same page as often as by nobody at all.
 */
export function parseExpansionState(raw: string | undefined): Record<string, boolean> {
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  const state: Record<string, boolean> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'boolean') state[key] = value
  }
  return state
}

/**
 * Only decisions about workspaces that still exist are written back. Without
 * the prune every run this phone has ever seen stays in the map forever, and
 * a recycled workspace id would come back wearing an answer from months ago.
 */
export function pruneExpansionState(
  state: Readonly<Record<string, boolean>>,
  knownIds: readonly string[]
): Record<string, boolean> {
  const known = new Set(knownIds)
  const pruned: Record<string, boolean> = {}
  for (const [key, value] of Object.entries(state)) {
    if (known.has(key)) pruned[key] = value
  }
  return pruned
}

export function readExpansionState(storage = browserStorage()): Record<string, boolean> {
  return parseExpansionState(readStored(EXPANSION_KEY, storage))
}

export function writeExpansionState(
  state: Readonly<Record<string, boolean>>,
  knownIds: readonly string[],
  storage = browserStorage()
): void {
  writeStored(EXPANSION_KEY, JSON.stringify(pruneExpansionState(state, knownIds)), storage)
}

// --- drafts ---------------------------------------------------------------

/**
 * Keys into the one draft map `App` holds for every text field on this screen.
 *
 * The map is lifted that far up because the *field* is what unmounts:
 * collapsing a card takes its composer down, and the same question is
 * answerable both from the inbox at the top and from the card it belongs to —
 * which has to be one draft, not two. Half-typed text outliving a tap is the
 * whole point.
 */
export const GOAL_DRAFT_KEY = 'goal'

export function composerDraftKey(workspaceId: string): string {
  return `composer:${workspaceId}`
}

/** `entryKey` is an `InboxEntry.key` — workspace, addressee and question. */
export function answerDraftKey(entryKey: string): string {
  return `answer:${entryKey}`
}

// --- the terminal's history entry ---------------------------------------

/**
 * What the history has to do for one change of the open agent.
 *
 * `pushed` is whether our own entry is still on the stack. It is the whole
 * state machine: a pop already removed the entry, so closing after a hardware
 * back must not call `back()` a second time and walk the user out of the app,
 * while closing from the in-app button must call it so the stack does not
 * grow an entry that leads nowhere.
 */
export type HistoryAction = 'push' | 'back' | 'none'

export function historyAction(
  previous: string | null,
  next: string | null,
  pushed: boolean
): HistoryAction {
  if (previous === null && next !== null && !pushed) return 'push'
  if (next === null && pushed) return 'back'
  return 'none'
}

// --- scroll ---------------------------------------------------------------

/**
 * Below this a restore is noise: iOS reports fractional offsets while the
 * address bar re-expands, and scrolling by a pixel is a visible twitch for no
 * gain.
 */
const SCROLL_DRIFT_TOLERANCE_PX = 2

/**
 * The offset to force back, or nothing if the document is already there.
 *
 * The overview stays mounted while a terminal is open, so in the normal case
 * the document never moved and this returns undefined — which is the point:
 * an unconditional `scrollTo` on every return would fight the browser's own
 * restoration on a back gesture instead of complementing it. It earns its
 * place only when the scroll lock leaked (a rubber-band on an older iOS) and
 * the offset really did drift.
 */
export function scrollRestoreTarget(recorded: number, current: number): number | undefined {
  if (!Number.isFinite(recorded) || recorded < 0) return undefined
  if (Math.abs(recorded - current) <= SCROLL_DRIFT_TOLERANCE_PX) return undefined
  return recorded
}

/** Roughly one thumb-flick of content; below it the control is in the way. */
const BACK_TO_TOP_THRESHOLD_PX = 400

export function shouldShowBackToTop(scrollY: number): boolean {
  return scrollY > BACK_TO_TOP_THRESHOLD_PX
}

// --- connection -----------------------------------------------------------

export type ConnectionState = 'connected' | 'connecting' | 'reconnecting' | 'offline'

/**
 * What the header says about the link.
 *
 * `navigator.onLine` wins over the socket phase: with the radio off or
 * Tailscale down, "reconnecting …" is a promise the client cannot keep, and a
 * spinner that never resolves is what makes a user reload and lose their
 * place. `everConnected` separates the first connect of a session from a
 * recovery, because the two need different reassurance.
 */
export function connectionState(
  phase: RemotePhase,
  online: boolean,
  everConnected: boolean
): ConnectionState {
  if (!online) return 'offline'
  if (phase === 'ready') return 'connected'
  return everConnected ? 'reconnecting' : 'connecting'
}

export function connectionLabel(
  state: ConnectionState,
  copy: { connected: string; connecting: string; reconnecting: string; offline: string }
): string {
  return copy[state]
}

/**
 * `ok` is the class `styles.css` already carries for a healthy link; the two
 * unhappy states get modifiers of their own, and plain `connecting` keeps the
 * neutral base. Colour is not the only signal — the label next to it says the
 * same thing in words.
 */
export function connectionClass(state: ConnectionState): string {
  if (state === 'connected') return 'conn ok'
  if (state === 'connecting') return 'conn'
  return `conn is-${state}`
}
