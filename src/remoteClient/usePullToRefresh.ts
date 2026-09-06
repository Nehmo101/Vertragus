/**
 * Pull-to-refresh at the top of the overview.
 *
 * The list is pushed, not polled, so a refresh is rarely *needed* — but after
 * a tunnel drop the user has no way to tell a quiet run from a stale screen,
 * and the phone-native answer to "is this current?" is to pull the list down.
 * The `⟳` in the header stays: it is the only one of the two that works with
 * a mouse, and the only one that works while the list is already at the top of
 * a short document.
 *
 * `styles.css` already sets `overscroll-behavior-y: contain`, which turns off
 * the browser's own pull-to-refresh — so this gesture replaces one that would
 * have reloaded the page and lost the user's place, rather than competing
 * with it.
 *
 * The pure half (distance curve, phase, label, axis lock, and the rule
 * deciding whether a gesture belongs to the pull at all) lives here as plain
 * functions: this project has no DOM test runner, so everything but the
 * two-line DOM read is held by a test, and the listeners are kept thin enough
 * to read.
 *
 * Scroll lives on the document (`html { overflow-y: auto }`). A window-level
 * non-passive `touchmove` janks or kills that pan on iOS Safari even when the
 * handler returns without cancelling, and Safari starts a native pan on the
 * first uncancelled move then ignores a later cancel for the rest of that
 * gesture. The hook therefore never claims the pan: every window listener is
 * `{ passive: true }` for its whole lifetime, the indicator is `position:
 * fixed` and moved with `transform` / `opacity` (a CSS custom property write
 * on the element, not a React state update), and the refresh decision is
 * taken on `touchend`. React phase state changes only at gesture boundaries
 * (claimed start, armed, release, refreshing, done).
 */
import { useEffect, useRef, useState, type RefObject } from 'react'
import { LIVENESS_PROBE_TIMEOUT_MS, LIVENESS_TICK_MS } from './connection'
import { haptic } from './haptics'

export type PullPhase = 'idle' | 'pulling' | 'armed' | 'refreshing' | 'unanswered'

/** How far the finger must travel before the release fires a refresh. */
export const PULL_THRESHOLD_PX = 64

/** Where the distance curve stops growing, however far the finger goes. */
const PULL_MAX_PX = 96

/** Finger travel per pixel of indicator — the drag has to feel weighted. */
const PULL_RESISTANCE = 0.5

/**
 * Slop before the gesture is claimed from the document. Under it the user may
 * still be starting an ordinary flick, and stealing that would make the list
 * feel stuck. The first axis that exceeds this wins forever: downward at the
 * top is a pull, anything else is a list pan — including an upward flick that
 * began with a few downward pixels of noise.
 */
export const PULL_CLAIM_PX = 8

/**
 * What a candidate pull has decided to be.
 *
 * `undecided` — still inside the slop; native document pan must keep working.
 * `pull` — first significant axis is downward at scroll top; we may claim.
 * `list` — first significant axis is an ordinary list pan (including a
 *          mostly-horizontal swipe); refused forever, even if later motion
 *          looks like a pull.
 */
export type PullIntent = 'undecided' | 'pull' | 'list'

/**
 * Lock the gesture to pull or list on the first significant axis.
 *
 * Once decided, never reopened: a downward noise at the start of an upward
 * flick must not become a pull when the finger later reverses, and an
 * already-claimed pull must not be re-read as a list pan mid-gesture.
 * A mostly-horizontal swipe is a list pan even at scroll top — claiming it
 * as a pull would fight the swipe the document already owns.
 *
 * `rawDeltaX` is optional so existing vertical-only callers stay valid; the
 * hook passes the finger's horizontal travel.
 */
export function pullIntent(
  rawDelta: number,
  scrollY: number,
  current: PullIntent,
  rawDeltaX = 0
): PullIntent {
  if (current !== 'undecided') return current
  if (!Number.isFinite(rawDelta) || !Number.isFinite(scrollY) || !Number.isFinite(rawDeltaX)) {
    return 'undecided'
  }
  const absY = Math.abs(rawDelta)
  const absX = Math.abs(rawDeltaX)
  if (absY <= PULL_CLAIM_PX && absX <= PULL_CLAIM_PX) return 'undecided'
  // First significant axis is horizontal: not a pull, forever.
  if (absX > absY) return 'list'
  // First significant axis is upward: the list, forever.
  if (rawDelta < 0) return 'list'
  // Downward, but the document has already left the top.
  if (scrollY > 0) return 'list'
  return 'pull'
}

/**
 * The tracking listener is on `window`, so every touch in the app passes
 * through it — including ones that belong to something else. `window.scrollY
 * <= 0` is not enough of a filter: at the top of a short document a text
 * field, a control and a nested scroller are all *at* scroll zero.
 *
 * Ownership is one `closest()` against this list, not an ancestor walk that
 * forces style. Fields and controls are tags; an inner scroller opts in
 * with `data-scroller` because overflow is not a selector.
 */
export const PULL_REFUSE_SELECTOR = [
  'input',
  'textarea',
  'select',
  '[contenteditable]:not([contenteditable="false"])',
  'button',
  'a',
  'summary',
  'label',
  '[data-scroller]'
].join(', ')

/** Enough of an element to answer `closest` — the DOM read is this one call. */
export interface GestureTarget {
  closest(selectors: string): unknown
}

/**
 * Whether the pull may claim a gesture that started on this target. A miss
 * (or no target at all — `event.target` outside the app) belongs to the
 * document. One matching ancestor is enough to refuse: the finger landing on
 * the label text inside Composer Send still finds the `<button>`.
 */
export function claimsGesture(target: GestureTarget | null): boolean {
  return target === null || target.closest(PULL_REFUSE_SELECTOR) === null
}

/** Resolve `event.target` to an Element, including a Text node inside one. */
function gestureTarget(target: EventTarget | null): GestureTarget | null {
  if (target instanceof Element) return target
  if (target instanceof Node) return target.parentElement
  return null
}

/**
 * How the pull finds out whether it got an answer.
 *
 * The `refresh` frame is still fire-and-forget — the protocol answers it with
 * a `workspaces` push indistinguishable from any other push, so there is
 * nothing to await. But `api.refresh` is `wake()`, and `wake()` leaves a
 * trace: on an open socket it sends a liveness probe (`probing` goes true
 * until something comes back), and on a closed one it reconnects (`ready`
 * goes false until the socket is authenticated again). Either way the link
 * carries the outcome of the gesture, which is exactly what the indicator
 * used to invent for itself.
 *
 * The defect that closes: `onEnd` cleared the strip after a fixed hold
 * whatever happened, so on a route that had died without closing its socket
 * the user watched a spinner run its course and conclude, having refreshed
 * nothing.
 */
export interface PullLink {
  /** `RemoteApi.probing`: a liveness probe is on the wire, unanswered. */
  probing: boolean
  /** `phase === 'ready'`: a socket that is open AND authenticated. */
  ready: boolean
}

/**
 * Whether the question the pull asked is still out. Both halves count: the
 * probe that has not been answered, and the reconnect that has not finished.
 */
export function refreshOutstanding(link: PullLink): boolean {
  return link.probing || !link.ready
}

/** What the strip should do next, once a pull has fired. */
export type RefreshVerdict = 'waiting' | 'answered' | 'unanswered'

/**
 * Judge a fired pull.
 *
 * `asked` is the caller's memory that the question was ever observed on the
 * wire — without it a link that is quietly `ready` and not probing (a pull
 * that raced a socket into `CLOSING`, say, so `wake()` had nothing to send)
 * would read as an instant success. `timedOut` is the ceiling having run out.
 *
 * An answer is any of: the probe came back (`probing` fell while the route
 * stayed ready) or the reconnect completed (`ready` returned, which arrives
 * with a fresh `workspaces` push — the very thing the pull asked for).
 */
export function refreshVerdict(asked: boolean, timedOut: boolean, link: PullLink): RefreshVerdict {
  if (asked && !refreshOutstanding(link)) return 'answered'
  return timedOut ? 'unanswered' : 'waiting'
}

/**
 * How long the strip waits before saying it got nothing.
 *
 * The client convicts a silent route one liveness tick after the probe window
 * closes, so this is the point past which the pull is not "slow", it is
 * unanswered — and waiting longer would only be a spinner keeping a secret
 * the client already knows.
 */
export const REFRESH_VERDICT_MS = LIVENESS_PROBE_TIMEOUT_MS + LIVENESS_TICK_MS

/**
 * A floor under the spinner, not a timeout: a probe answered in 80 ms would
 * otherwise flash the strip open and shut, which reads as a gesture that
 * failed to register rather than one that succeeded immediately.
 */
const REFRESH_FLOOR_MS = 700

/** Long enough to read the verdict, short enough to stop being in the way. */
const UNANSWERED_HOLD_MS = 4_000

export function pullDistance(rawDelta: number): number {
  if (rawDelta <= 0) return 0
  return Math.min(PULL_MAX_PX, rawDelta * PULL_RESISTANCE)
}

/** What a fired pull is doing, as the hook tracks it between renders. */
export type RefreshStage = 'idle' | 'waiting' | 'unanswered'

/** Finger phase while the refresh machine is idle. */
export type PullGesture = 'idle' | 'pulling' | 'armed'

export function pullPhase(distance: number, stage: RefreshStage): PullPhase {
  // Both outcomes outrank the finger: it left the screen when the pull fired.
  if (stage !== 'idle') return stage === 'waiting' ? 'refreshing' : 'unanswered'
  if (distance >= PULL_THRESHOLD_PX) return 'armed'
  return distance > 0 ? 'pulling' : 'idle'
}

/** Discrete finger phase from the distance curve, for boundary setState. */
export function pullGesture(distance: number): PullGesture {
  const phase = pullPhase(distance, 'idle')
  return phase === 'armed' || phase === 'pulling' ? phase : 'idle'
}

export function pullLabel(
  phase: PullPhase,
  copy: {
    pullToRefresh: string
    releaseToRefresh: string
    refreshing: string
    pullNoAnswer: string
  }
): string | undefined {
  if (phase === 'pulling') return copy.pullToRefresh
  if (phase === 'armed') return copy.releaseToRefresh
  if (phase === 'refreshing') return copy.refreshing
  // This used to borrow `reconnecting …`, which was true of the moment but
  // said only half of it: the client is indeed reconnecting, and the list in
  // front of the user is still the stale one they pulled to replace.
  // `pullNoAnswer` says both.
  if (phase === 'unanswered') return copy.pullNoAnswer
  return undefined
}

/**
 * How many pixels of the fixed indicator are on screen. The element itself
 * never changes height — a CSS custom property drives `translateY` — so the
 * document is the same length under the finger as it was at touchstart.
 */
export const PULL_INDICATOR_PX = 34

export function pullIndicatorShown(phase: PullPhase, distance: number): number {
  if (phase === 'idle') return 0
  if (phase === 'refreshing' || phase === 'unanswered') return PULL_INDICATOR_PX
  return Math.round(Math.min(PULL_INDICATOR_PX, Math.max(0, distance)))
}

export function pullIndicatorOpacity(phase: PullPhase, distance: number): number {
  if (phase === 'idle') return 0
  if (phase === 'refreshing' || phase === 'unanswered' || phase === 'armed') return 1
  return Math.min(1, Math.max(0, distance) / PULL_INDICATOR_PX)
}

function paintIndicator(el: HTMLElement | null, phase: PullPhase, distance: number): void {
  if (!el) return
  el.style.setProperty('--pull-shown', `${pullIndicatorShown(phase, distance)}px`)
  el.style.setProperty('--pull-opacity', String(pullIndicatorOpacity(phase, distance)))
}

/**
 * Whether a lifted finger fires the refresh.
 *
 * Distance alone is not enough, and the gap was reachable with one hand: pull
 * the list 70 px, put a second finger down to pinch-zoom, lift. The second
 * `touchstart` is ineligible so the pull stops tracking — but the distance it
 * had already travelled was still sitting in the ref, and `touchend` read it
 * and refreshed a list the user had stopped pulling two gestures ago.
 * `claimed` is the gesture still being ours; an abandoned pull owns nothing.
 */
export function shouldFireRefresh(distance: number, claimed: boolean): boolean {
  return claimed && distance >= PULL_THRESHOLD_PX
}

export interface PullState {
  phase: PullPhase
}

export function usePullToRefresh(
  onRefresh: () => void,
  enabled: boolean,
  link: PullLink,
  indicator: RefObject<HTMLDivElement>
): PullState {
  const [gesture, setGesture] = useState<PullGesture>('idle')
  const [stage, setStage] = useState<RefreshStage>('idle')
  const [timedOut, setTimedOut] = useState(false)
  const startY = useRef<number | null>(null)
  const startX = useRef<number | null>(null)
  const distanceRef = useRef(0)
  const gestureRef = useRef<PullGesture>('idle')
  const stageRef = useRef<RefreshStage>('idle')
  const refreshRef = useRef(onRefresh)
  /**
   * Whether this pull's question has been seen on the wire. A ref, not state:
   * it is written from the effect that reads the link and must be true for
   * the SAME pass that then judges it, which a queued `setState` would not be.
   */
  const asked = useRef(false)
  const firedAt = useRef(0)
  // Primitives, so the effects below depend on what actually changed rather
  // than on a `link` object the caller rebuilds on every render.
  const { probing, ready } = link

  useEffect(() => {
    refreshRef.current = onRefresh
  }, [onRefresh])

  useEffect(() => {
    let intent: PullIntent = 'undecided'

    const publishGesture = (next: PullGesture): void => {
      if (next === gestureRef.current) return
      if (next === 'armed') haptic('tap')
      gestureRef.current = next
      setGesture(next)
    }

    const hide = (): void => {
      paintIndicator(indicator.current, 'idle', 0)
    }

    const reset = (): void => {
      startY.current = null
      startX.current = null
      distanceRef.current = 0
      intent = 'undecided'
      hide()
      publishGesture('idle')
    }
    if (!enabled) {
      reset()
      return
    }

    const onStart = (event: TouchEvent): void => {
      const eligible =
        event.touches.length === 1 &&
        window.scrollY <= 0 &&
        stageRef.current === 'idle' &&
        claimsGesture(gestureTarget(event.target))
      // A full reset, not just `startY`: an ineligible start is the second
      // finger of a pinch as often as it is a tap in a text field, and
      // whatever distance the first finger had already travelled must not
      // survive to be read by the `touchend` that ends the new gesture.
      if (!eligible) {
        reset()
        return
      }
      startY.current = event.touches[0]?.clientY ?? null
      startX.current = event.touches[0]?.clientX ?? null
      intent = 'undecided'
    }

    function onMove(event: TouchEvent): void {
      const start = startY.current
      const touch = event.touches[0]
      if (start === null || !touch || event.touches.length !== 1) return
      if (stageRef.current !== 'idle') return
      const raw = touch.clientY - start
      const originX = startX.current
      const rawX = originX === null ? 0 : touch.clientX - originX
      intent = pullIntent(raw, window.scrollY, intent, rawX)

      if (intent === 'list') {
        reset()
        return
      }

      if (intent === 'pull') {
        if (raw <= 0 || window.scrollY > 0) {
          reset()
          return
        }
        const distance = pullDistance(raw)
        distanceRef.current = distance
        const next = pullGesture(distance)
        // The document height must not change under a native pan: write the
        // overlay through the element, never through React.
        paintIndicator(indicator.current, next, distance)
        // React only at the claim / arm / disarm edges, not per move.
        publishGesture(next)
        return
      }

      // Still inside the slop: preview the overlay, never publish a phase.
      if (raw > 0 && window.scrollY <= 0) {
        const distance = pullDistance(raw)
        distanceRef.current = distance
        paintIndicator(indicator.current, pullGesture(distance), distance)
      } else {
        distanceRef.current = 0
        paintIndicator(indicator.current, 'idle', 0)
      }
    }

    const onEnd = (): void => {
      const fire = shouldFireRefresh(distanceRef.current, startY.current !== null)
      startY.current = null
      startX.current = null
      intent = 'undecided'
      if (!fire) {
        distanceRef.current = 0
        hide()
        publishGesture('idle')
        return
      }
      // Everything the verdict is measured from is stamped here; the effects
      // below own the outcome, because only the link knows what it is.
      asked.current = false
      firedAt.current = Date.now()
      gestureRef.current = 'idle'
      stageRef.current = 'waiting'
      setGesture('idle')
      setTimedOut(false)
      setStage('waiting')
      paintIndicator(indicator.current, 'refreshing', 0)
      refreshRef.current()
    }

    window.addEventListener('touchstart', onStart, { passive: true })
    window.addEventListener('touchmove', onMove, { passive: true })
    window.addEventListener('touchend', onEnd, { passive: true })
    window.addEventListener('touchcancel', reset, { passive: true })
    return () => {
      window.removeEventListener('touchstart', onStart)
      window.removeEventListener('touchmove', onMove)
      window.removeEventListener('touchend', onEnd)
      window.removeEventListener('touchcancel', reset)
    }
  }, [enabled, indicator])

  // The ceiling. Restarted whenever a new pull enters `waiting`, cleared with
  // it, so a second pull is never convicted by the first one's clock.
  useEffect(() => {
    if (stage !== 'waiting') return
    const timer = window.setTimeout(() => setTimedOut(true), REFRESH_VERDICT_MS)
    return () => window.clearTimeout(timer)
  }, [stage])

  // The verdict. Runs on every change in the link while a pull is waiting.
  useEffect(() => {
    if (stage !== 'waiting') return
    const current = { probing, ready }
    // Seeing the question go out is what makes a later quiet link an answer
    // rather than a link that was never asked anything.
    if (refreshOutstanding(current)) asked.current = true
    const verdict = refreshVerdict(asked.current, timedOut, current)
    if (verdict === 'waiting') return
    if (verdict === 'unanswered') {
      stageRef.current = 'unanswered'
      setStage('unanswered')
      paintIndicator(indicator.current, 'unanswered', 0)
      return
    }
    // Answered: close the strip, but never sooner than the floor — an
    // indicator that vanishes in 80 ms reads as a gesture that did not take.
    const remaining = Math.max(0, REFRESH_FLOOR_MS - (Date.now() - firedAt.current))
    const timer = window.setTimeout(() => {
      stageRef.current = 'idle'
      setStage('idle')
      paintIndicator(indicator.current, 'idle', 0)
    }, remaining)
    return () => window.clearTimeout(timer)
  }, [stage, timedOut, probing, ready, indicator])

  // The honest outcome gets read time, then gets out of the way. The header
  // pill keeps saying what the link is doing after this strip has closed.
  useEffect(() => {
    if (stage !== 'unanswered') return
    const timer = window.setTimeout(() => {
      stageRef.current = 'idle'
      setStage('idle')
      paintIndicator(indicator.current, 'idle', 0)
    }, UNANSWERED_HOLD_MS)
    return () => window.clearTimeout(timer)
  }, [stage, indicator])

  return {
    phase: pullPhase(gesture === 'armed' ? PULL_THRESHOLD_PX : gesture === 'pulling' ? 1 : 0, stage)
  }
}
