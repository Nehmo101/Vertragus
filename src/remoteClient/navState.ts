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

/**
 * Nothing is written until the client knows of a workspace.
 *
 * `useRemote` starts `workspaces` at `[]`, and an empty list is exactly what a
 * client that never reached the host has: without this guard the very first
 * commit prunes every remembered card against a list of nothing and overwrites
 * the store with `{}`. Open the app out of tailnet range once and every
 * collapse decision the user ever made is gone — a write is the one thing that
 * cannot be undone by the next push arriving.
 *
 * The cost is that a host which genuinely has no workspaces left never gets
 * its stale keys pruned. They are inert (`isWorkspaceExpanded` only ever asks
 * about ids that exist) and the first push with a workspace in it clears them.
 */
export function writeExpansionState(
  state: Readonly<Record<string, boolean>>,
  knownIds: readonly string[],
  storage = browserStorage()
): void {
  if (knownIds.length === 0) return
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

/**
 * The longest value the gateway will accept.
 *
 * `protocol.ts` caps every `args` value at 20 000 characters and the server's
 * validator drops the whole frame past it — so an over-long paste would leave
 * the user looking at a field full of text, a button that did nothing, and no
 * explanation. The fields carry it as `maxLength` instead, which is the
 * browser telling the truth at the moment of the paste.
 * `navState.test.ts` pins this number against the schema itself.
 */
export const ARG_MAX_CHARS = 20_000

export type DraftKind = 'goal' | 'composer' | 'answer'

export interface OrphanDraft {
  key: string
  text: string
  kind: DraftKind
  /** The run the text was meant for, when it is still on the list. */
  workspaceId?: string
}

/**
 * Which run a draft key belongs to, matched against ids the host still
 * carries rather than parsed. Both key shapes embed a workspace id and an
 * `InboxEntry.key` puts two more colon-joined fields after it, so splitting on
 * ':' would guess wrong the first time a host hands out an id with a colon in
 * it. Comparing against the ids we actually have cannot guess.
 */
export function draftWorkspaceId(
  key: string,
  knownIds: readonly string[]
): string | undefined {
  for (const id of knownIds) {
    if (key === composerDraftKey(id)) return id
    if (key.startsWith(answerDraftKey(`${id}:`))) return id
  }
  return undefined
}

export function draftKind(key: string): DraftKind {
  if (key === GOAL_DRAFT_KEY) return 'goal'
  return key.startsWith('composer:') ? 'composer' : 'answer'
}

/**
 * The draft map, bounded.
 *
 * `setDraft` only ever added keys, so the map grew for the life of the tab:
 * one entry per workspace ever seen and one per question ever asked, none of
 * them ever removed, and the empty strings left behind by a successful send
 * kept their keys forever too. Two rules bound it: an empty draft is not a
 * draft, and a draft whose run the host no longer carries has nowhere to go —
 * the same rule, and the same recycled-id argument, as
 * `pruneExpansionState`. What is deliberately NOT dropped is text for a run
 * that is still on the list; that text is the user's, and `orphanedDrafts`
 * puts it back on the screen instead of deleting it behind their back.
 *
 * Returns the same object when nothing was dropped, so this can run on every
 * push without causing a render.
 */
export function pruneDrafts(
  drafts: Readonly<Record<string, string>>,
  knownWorkspaceIds: readonly string[]
): Readonly<Record<string, string>> {
  const kept: Record<string, string> = {}
  let dropped = false
  for (const [key, text] of Object.entries(drafts)) {
    const keep =
      text !== '' &&
      (key === GOAL_DRAFT_KEY || draftWorkspaceId(key, knownWorkspaceIds) !== undefined)
    if (keep) kept[key] = text
    else dropped = true
  }
  return dropped ? kept : drafts
}

/**
 * The runs a composer is drawn for.
 *
 * This exists as a function rather than a `filter` at the call site so that
 * the gate is one thing in one place: `WorkspaceCard` renders `<Composer>`
 * under `workspace.active`, and `liveDraftKeys` has to agree with it or text
 * goes missing (see below). A test that wants the real call shape derives it
 * from a workspace list through here, instead of hand-writing a key list the
 * application would never produce.
 */
export function composerWorkspaceIds(
  workspaces: readonly { workspaceId: string; active: boolean }[]
): string[] {
  return workspaces
    .filter((workspace) => workspace.active)
    .map((workspace) => workspace.workspaceId)
}

/**
 * Every draft key the screen can still show a field for.
 *
 * The first argument is deliberately NOT every workspace the host carries: it
 * is the ids that still get a composer drawn for them, which `App` gates on
 * `workspace.active`. Passing all of them was a data-loss bug rather than a
 * cosmetic one — an ended-but-still-listed run kept its composer key in this
 * list, so `orphanedDrafts` counted the text as reachable, while the field it
 * was typed into had already gone with the run. The sentence then sat in the
 * map, invisible and undiscardable, until the host dropped the workspace and
 * `pruneDrafts` deleted it unseen. Liveness has to be decided by the same
 * condition that decides whether the field is rendered.
 *
 * Collapsing a card also unmounts its composer, and that case deliberately
 * does NOT belong here: the user closed it and can open it again, so the text
 * is one tap away rather than orphaned. Only ending is irreversible from the
 * phone.
 */
export function liveDraftKeys(
  composerIds: readonly string[],
  inboxEntryKeys: readonly string[]
): string[] {
  return [
    GOAL_DRAFT_KEY,
    ...composerIds.map(composerDraftKey),
    ...inboxEntryKeys.map(answerDraftKey)
  ]
}

/**
 * Text the user typed that no field on the screen can reach any more.
 *
 * Two ordinary things produce it. A question answered from the DESKTOP leaves
 * the inbox, and with it the field holding a half-typed answer — which until
 * now simply vanished mid-sentence with nothing said. And a composer draft
 * belongs to a run that has ended, so the field it was typed into is gone and
 * the message can never be sent. Both are the user's words; the screen owes
 * them a sight of them and a deliberate discard, not a silent deletion.
 *
 * Sorted by key so the notice does not reshuffle under a thumb.
 */
export function orphanedDrafts(
  drafts: Readonly<Record<string, string>>,
  liveKeys: readonly string[],
  knownWorkspaceIds: readonly string[]
): OrphanDraft[] {
  const live = new Set(liveKeys)
  return Object.entries(drafts)
    .filter(([key, text]) => text.trim() !== '' && !live.has(key))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, text]) => ({
      key,
      text,
      kind: draftKind(key),
      workspaceId: draftWorkspaceId(key, knownWorkspaceIds)
    }))
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
  // `previous !== null` is not decoration: without it a first run of this
  // effect with nothing open at all — no terminal, no change — reads as an
  // in-app close and calls `back()`, which walks the user out of the app.
  // `pushed` should never be true there, but "should never" is not a guard.
  if (previous !== null && next === null && pushed) return 'back'
  return 'none'
}

/**
 * What a `popstate` means.
 *
 * `history.back()` is asynchronous: the traversal is a queued task, so the
 * pop it produces can land one or more frames after the close that asked for
 * it. Close the terminal with the in-app button and tap another agent in the
 * same frame and the naive handler sees `pushed` back at true and closes the
 * terminal the user has only just opened. `pendingBacks` counts the
 * traversals we asked for and have not yet seen land; each one settles the
 * pop it owns and changes nothing else.
 */
export type PopAction = 'settle' | 'close' | 'none'

export function popstateAction(pendingBacks: number, pushed: boolean): PopAction {
  if (pendingBacks > 0) return 'settle'
  return pushed ? 'close' : 'none'
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

/**
 * A scripted scroll has to ask about reduced motion itself. `styles.css`
 * turns `scroll-behavior` off under the media query, but an explicit
 * `behavior: 'smooth'` in a `scrollTo` outranks the sheet entirely — so the
 * one control that animates the whole page would keep animating for exactly
 * the person who asked it not to.
 */
export function scrollBehavior(reducedMotion: boolean): ScrollBehavior {
  return reducedMotion ? 'auto' : 'smooth'
}

/** False wherever the query cannot be asked — no motion promise is broken. */
export function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

// --- connection -----------------------------------------------------------

export type ConnectionState = 'connected' | 'checking' | 'connecting' | 'reconnecting' | 'offline'

/**
 * What the header says about the link.
 *
 * `navigator.onLine` wins over the socket phase, but only for what it can
 * actually prove: with the radio off or in flight mode it is false, and
 * "reconnecting …" would be a promise the client cannot keep. It proves
 * nothing about the tailnet — Wi-Fi up and Tailscale down reads as online,
 * and the honest "reconnecting …" the user then sees is bounded by the
 * liveness probe, not by this flag. `everConnected` separates the first
 * connect of a session from a recovery, because the two need different
 * reassurance.
 *
 * `probing` is the fourth input because `phase` alone cannot tell the truth
 * here. A route that dies without closing its socket leaves `phase` at
 * `'ready'` for the whole silence window AND the whole probe window — up to
 * `LIVENESS_SILENCE_MS + LIVENESS_PROBE_TIMEOUT_MS` (40 s) of a pill reading
 * "connected" over a link that answers nothing. `probing` marks the part of
 * that window the client has actual evidence about: a question is on the wire
 * and unanswered, so the honest word is "checking", not "connected".
 *
 * What this does NOT fix, and must not be read as fixing: the first 30 s is
 * silence nobody has yet asked a question about. The client has no evidence
 * either way there, so no honest signal exists to show — a pill that hedged
 * through it would be guessing, which is the same lie in the other direction.
 * The worst case therefore becomes "connected" for 30 s, then "checking" for
 * at most 10 s, then "reconnecting …". Shortening the first leg means probing
 * more often, which is a battery decision in `connection.ts`, not a label one.
 *
 * The caller passes a probe that has been outstanding long enough to be worth
 * saying, not the raw flag — see `useSettledProbing` in `App.tsx`, which keeps
 * the routine probe on a healthy link from blinking the pill twice a minute.
 * That grace is two seconds against a ten-second probe window; this function
 * neither knows nor cares, which is why it stays a boolean.
 */
export function connectionState(
  phase: RemotePhase,
  online: boolean,
  everConnected: boolean,
  probing: boolean
): ConnectionState {
  if (!online) return 'offline'
  if (phase === 'ready') return probing ? 'checking' : 'connected'
  return everConnected ? 'reconnecting' : 'connecting'
}

export function connectionLabel(
  state: ConnectionState,
  copy: {
    connected: string
    checking: string
    connecting: string
    reconnecting: string
    offline: string
  }
): string {
  // Every state now has a string of its own. `checking` used to borrow
  // `connecting …` — true enough to ship, but it said "in progress" where the
  // honest thing to say is that a question is on the wire and unanswered.
  return copy[state]
}

/**
 * `ok` is the class `styles.css` already carries for a healthy link; the
 * three states that are not simply healthy get modifiers of their own, and
 * plain `connecting` keeps the neutral base. Colour is not the only signal —
 * the label next to it says the same thing in words, which is what keeps
 * `checking` distinguishable from `reconnecting` for a user who cannot tell
 * two ambers apart.
 */
export function connectionClass(state: ConnectionState): string {
  if (state === 'connected') return 'conn ok'
  if (state === 'connecting') return 'conn'
  return `conn is-${state}`
}
