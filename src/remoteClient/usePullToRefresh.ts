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
 * `{ passive: false }` `touchmove` — even one that returns without
 * `preventDefault` — janks or kills that pan on iOS Safari. The lifetime
 * listener therefore stays `{ passive: true }`. An eligible `touchstart`
 * (scroll top, not a field/control/scroller) arms a *second*, cancelable
 * `touchmove` before the first move of that gesture: WebKit ignores
 * `preventDefault` on a listener added mid-move (184250), and a passive
 * delivery cannot cancel its own event. That cancelable listener still only
 * `preventDefault`s once `pullIntent` is `pull`; slop and list pans are
 * never cancelled. It is removed on lift.
 */
import { useEffect, useRef, useState } from 'react'
import { LIVENESS_PROBE_TIMEOUT_MS, LIVENESS_TICK_MS } from './connection'
import { haptic } from './haptics'

export type PullPhase = 'idle' | 'pulling' | 'armed' | 'refreshing' | 'unanswered'

/** How far the finger must travel before the release fires a refresh. */
export const PULL_THRESHOLD_PX = 64

/** Where the indicator stops growing, however far the finger goes. */
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
 * as a pull would `preventDefault` and kill the swipe.
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
 * Only a claimed pull may `preventDefault`. A list pan, and the slop before
 * either axis has won, must not — that is what used to leave the overview
 * stuck until lift.
 */
export function shouldPreventPullMove(intent: PullIntent): boolean {
  return intent === 'pull'
}

/**
 * The tracking listener is on `window`, so every touch in the app passes
 * through it — including ones that belong to something else. `window.scrollY
 * <= 0` is not enough of a filter: at the top of a short document a text
 * field, a horizontally scrolling strip and the composer's textarea are all
 * *at* scroll zero, and each of them would have its own gesture cancelled by
 * our `preventDefault`.
 *
 * So the start is also filtered by where the finger landed: the chain from the
 * touched element up to the root is walked once, at `touchstart`, and the pull
 * is refused if anything in it owns touches of its own. Once refused the
 * gesture is never claimed — `startY` stays null and `touchmove` returns before
 * it can call `preventDefault`.
 */
const SCROLLABLE_OVERFLOW = new Set(['auto', 'scroll', 'overlay'])

/**
 * The subpixel tolerance. Layout rounding leaves an element one fractional
 * pixel of "scrollable" content it cannot actually scroll; treating that as a
 * scroller would refuse the pull over most of the list.
 */
const SCROLL_SLACK_PX = 1

/** The properties of one ancestor that decide whether it owns the gesture. */
export interface GestureNode {
  /** Uppercase, as `Element.tagName` reports it. */
  tagName: string
  /** `HTMLElement.isContentEditable` — a rich-text host is a field too. */
  editable: boolean
  overflowX: string
  overflowY: string
  scrollWidth: number
  clientWidth: number
  scrollHeight: number
  clientHeight: number
}

/**
 * A field owns every touch that starts inside it: placing a caret, dragging a
 * selection, and — in a `<textarea>` — scrolling its own overflowing text.
 * None of those may be turned into a page pull.
 */
export function ownsTouchAsField(node: GestureNode): boolean {
  if (node.editable) return true
  return node.tagName === 'TEXTAREA' || node.tagName === 'INPUT' || node.tagName === 'SELECT'
}

/**
 * Interactive controls own the gesture the same way a field does. A tap on
 * Composer Send (`.primary`, `type="button"`) at `scrollY <= 0` with a few
 * pixels of finger noise used to be claimed as a pull; `preventDefault` on
 * that `touchmove` cancelled the click, so the follow-up never left.
 */
const CONTROL_TAGS = new Set(['BUTTON', 'A', 'SUMMARY', 'LABEL'])

export function ownsTouchAsControl(node: GestureNode): boolean {
  return CONTROL_TAGS.has(node.tagName)
}

/**
 * An element that can pan under the finger itself, in either axis. Horizontal
 * matters as much as vertical: a swipe across a scrolling strip starts with a
 * few vertical pixels of noise, and claiming those would leave the strip stuck
 * while the whole page bounced instead.
 */
export function ownsTouchAsScroller(node: GestureNode): boolean {
  const horizontal =
    SCROLLABLE_OVERFLOW.has(node.overflowX) &&
    node.scrollWidth > node.clientWidth + SCROLL_SLACK_PX
  const vertical =
    SCROLLABLE_OVERFLOW.has(node.overflowY) &&
    node.scrollHeight > node.clientHeight + SCROLL_SLACK_PX
  return horizontal || vertical
}

/**
 * Whether the pull may claim a gesture that started inside this ancestor chain
 * (touched element first, root last). One owner anywhere in the chain is
 * enough to refuse: a field, a control (Composer Send), or a nested scroller
 * keeps the gesture; the strip is what scrolls, not the element inside it
 * that the finger happened to land on.
 */
export function claimsGesture(chain: readonly GestureNode[]): boolean {
  return !chain.some(
    (node) => ownsTouchAsField(node) || ownsTouchAsControl(node) || ownsTouchAsScroller(node)
  )
}

/** Read the chain out of the DOM. Live values only — no cache to go stale. */
function gestureChain(target: EventTarget | null): GestureNode[] {
  const chain: GestureNode[] = []
  let element = target instanceof Element ? target : null
  // `documentElement` is excluded on purpose: it *is* the document scroller,
  // and the pull is precisely the gesture that belongs to it.
  while (element && element !== document.documentElement) {
    const style = window.getComputedStyle(element)
    chain.push({
      tagName: element.tagName,
      editable: element instanceof HTMLElement && element.isContentEditable,
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight
    })
    element = element.parentElement
  }
  return chain
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

export function pullPhase(distance: number, stage: RefreshStage): PullPhase {
  // Both outcomes outrank the finger: it left the screen when the pull fired.
  if (stage !== 'idle') return stage === 'waiting' ? 'refreshing' : 'unanswered'
  if (distance >= PULL_THRESHOLD_PX) return 'armed'
  return distance > 0 ? 'pulling' : 'idle'
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
 * How tall the indicator strip is. While the refresh is in flight the finger
 * is already gone, so there is no distance left to follow and the strip holds
 * a fixed height instead of snapping shut under the label it is showing.
 */
const REFRESHING_HEIGHT_PX = 34

export function pullIndicatorHeight(phase: PullPhase, distance: number): number {
  if (phase === 'refreshing' || phase === 'unanswered') return REFRESHING_HEIGHT_PX
  return Math.round(Math.max(0, distance))
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
  distance: number
}

export function usePullToRefresh(
  onRefresh: () => void,
  enabled: boolean,
  link: PullLink
): PullState {
  const [distance, setDistance] = useState(0)
  const [stage, setStage] = useState<RefreshStage>('idle')
  const [timedOut, setTimedOut] = useState(false)
  const startY = useRef<number | null>(null)
  const startX = useRef<number | null>(null)
  const distanceRef = useRef(0)
  const armedRef = useRef(false)
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
    /**
     * The tracking `touchmove` is passive for the lifetime of the overview.
     * iOS Safari janks or kills document pan for a window-level non-passive
     * `touchmove` even when the handler returns without `preventDefault`.
     * A second, cancelable listener is armed from an *eligible* `touchstart`
     * (before the first `touchmove` of that gesture) and only
     * `preventDefault`s once the intent is `pull`.
     */
    let cancelableBound = false

    function onCancelableMove(event: TouchEvent): void {
      if (shouldPreventPullMove(intent) && event.cancelable) event.preventDefault()
    }

    function armCancelableMove(): void {
      if (cancelableBound) return
      window.addEventListener('touchmove', onCancelableMove, { passive: false })
      cancelableBound = true
    }

    function disarmCancelableMove(): void {
      if (!cancelableBound) return
      window.removeEventListener('touchmove', onCancelableMove)
      cancelableBound = false
    }

    const reset = (): void => {
      startY.current = null
      startX.current = null
      distanceRef.current = 0
      armedRef.current = false
      intent = 'undecided'
      disarmCancelableMove()
      setDistance(0)
    }
    if (!enabled) {
      reset()
      return
    }

    const track = (next: number): void => {
      distanceRef.current = next
      setDistance(next)
      const armed = next >= PULL_THRESHOLD_PX
      if (armed !== armedRef.current) {
        armedRef.current = armed
        if (armed) haptic('tap')
      }
    }

    const onStart = (event: TouchEvent): void => {
      const eligible =
        event.touches.length === 1 && window.scrollY <= 0 && claimsGesture(gestureChain(event.target))
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
      armCancelableMove()
    }

    function onMove(event: TouchEvent): void {
      const start = startY.current
      const touch = event.touches[0]
      if (start === null || !touch || event.touches.length !== 1) return
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
        track(pullDistance(raw))
        return
      }

      // Still inside the slop: preview the indicator at the top, never claim.
      if (raw > 0 && window.scrollY <= 0) track(pullDistance(raw))
      else track(0)
    }

    const onEnd = (): void => {
      const fire = shouldFireRefresh(distanceRef.current, startY.current !== null)
      reset()
      if (!fire) return
      // Everything the verdict is measured from is stamped here; the effects
      // below own the outcome, because only the link knows what it is.
      asked.current = false
      firedAt.current = Date.now()
      setTimedOut(false)
      setStage('waiting')
      refreshRef.current()
    }

    window.addEventListener('touchstart', onStart, { passive: true })
    window.addEventListener('touchmove', onMove, { passive: true })
    window.addEventListener('touchend', onEnd, { passive: true })
    window.addEventListener('touchcancel', reset, { passive: true })
    return () => {
      window.removeEventListener('touchstart', onStart)
      window.removeEventListener('touchmove', onMove)
      window.removeEventListener('touchmove', onCancelableMove)
      window.removeEventListener('touchend', onEnd)
      window.removeEventListener('touchcancel', reset)
    }
  }, [enabled])

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
      setStage('unanswered')
      return
    }
    // Answered: close the strip, but never sooner than the floor — an
    // indicator that vanishes in 80 ms reads as a gesture that did not take.
    const remaining = Math.max(0, REFRESH_FLOOR_MS - (Date.now() - firedAt.current))
    const timer = window.setTimeout(() => setStage('idle'), remaining)
    return () => window.clearTimeout(timer)
  }, [stage, timedOut, probing, ready])

  // The honest outcome gets read time, then gets out of the way. The header
  // pill keeps saying what the link is doing after this strip has closed.
  useEffect(() => {
    if (stage !== 'unanswered') return
    const timer = window.setTimeout(() => setStage('idle'), UNANSWERED_HOLD_MS)
    return () => window.clearTimeout(timer)
  }, [stage])

  return { phase: pullPhase(distance, stage), distance }
}
