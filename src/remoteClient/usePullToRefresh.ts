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
 * The pure half (distance curve, phase, label, and the rule deciding whether a
 * gesture belongs to the pull at all) lives here as plain functions: this
 * project has no DOM test runner, so everything but the two-line DOM read is
 * held by a test, and the listeners are kept thin enough to read.
 */
import { useEffect, useRef, useState } from 'react'
import { haptic } from './haptics'

export type PullPhase = 'idle' | 'pulling' | 'armed' | 'refreshing'

/** How far the finger must travel before the release fires a refresh. */
export const PULL_THRESHOLD_PX = 64

/** Where the indicator stops growing, however far the finger goes. */
const PULL_MAX_PX = 96

/** Finger travel per pixel of indicator — the drag has to feel weighted. */
const PULL_RESISTANCE = 0.5

/**
 * Slop before the gesture is claimed from the document. Under it the user may
 * still be starting an ordinary flick, and stealing that would make the list
 * feel stuck.
 */
const PULL_CLAIM_PX = 8

/**
 * The listener is on `window`, so every touch in the app passes through it —
 * including ones that belong to something else. `window.scrollY <= 0` is not
 * enough of a filter: at the top of a short document a text field, a
 * horizontally scrolling strip and the composer's textarea are all *at* scroll
 * zero, and each of them would have its own gesture cancelled by our
 * `preventDefault`.
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
 * enough to refuse: the strip is what scrolls, not the element inside it that
 * the finger happened to land on.
 */
export function claimsGesture(chain: readonly GestureNode[]): boolean {
  return !chain.some((node) => ownsTouchAsField(node) || ownsTouchAsScroller(node))
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
 * The `refresh` frame is fire-and-forget — the protocol answers it with a
 * `workspaces` push that is indistinguishable from any other push, so there
 * is nothing to await. The indicator is therefore time-boxed: it acknowledges
 * the gesture rather than claiming the data has arrived.
 */
const REFRESH_HOLD_MS = 700

export function pullDistance(rawDelta: number): number {
  if (rawDelta <= 0) return 0
  return Math.min(PULL_MAX_PX, rawDelta * PULL_RESISTANCE)
}

export function pullPhase(distance: number, refreshing: boolean): PullPhase {
  if (refreshing) return 'refreshing'
  if (distance >= PULL_THRESHOLD_PX) return 'armed'
  return distance > 0 ? 'pulling' : 'idle'
}

export function pullLabel(
  phase: PullPhase,
  copy: { pullToRefresh: string; releaseToRefresh: string; refreshing: string }
): string | undefined {
  if (phase === 'pulling') return copy.pullToRefresh
  if (phase === 'armed') return copy.releaseToRefresh
  if (phase === 'refreshing') return copy.refreshing
  return undefined
}

/**
 * How tall the indicator strip is. While the refresh is in flight the finger
 * is already gone, so there is no distance left to follow and the strip holds
 * a fixed height instead of snapping shut under the label it is showing.
 */
const REFRESHING_HEIGHT_PX = 34

export function pullIndicatorHeight(phase: PullPhase, distance: number): number {
  if (phase === 'refreshing') return REFRESHING_HEIGHT_PX
  return Math.round(Math.max(0, distance))
}

export interface PullState {
  phase: PullPhase
  distance: number
}

export function usePullToRefresh(onRefresh: () => void, enabled: boolean): PullState {
  const [distance, setDistance] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const startY = useRef<number | null>(null)
  const distanceRef = useRef(0)
  const armedRef = useRef(false)
  const refreshRef = useRef(onRefresh)
  const timerRef = useRef<number | undefined>(undefined)

  useEffect(() => {
    refreshRef.current = onRefresh
  }, [onRefresh])

  useEffect(() => {
    const reset = (): void => {
      startY.current = null
      distanceRef.current = 0
      armedRef.current = false
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
      startY.current = eligible ? (event.touches[0]?.clientY ?? null) : null
    }

    const onMove = (event: TouchEvent): void => {
      const start = startY.current
      const touch = event.touches[0]
      if (start === null || !touch || event.touches.length !== 1) return
      const raw = touch.clientY - start
      // An upward move, a second finger, or a document that has scrolled away
      // from the top all mean this was never a pull.
      if (raw <= 0 || window.scrollY > 0) {
        reset()
        return
      }
      if (raw > PULL_CLAIM_PX && event.cancelable) event.preventDefault()
      track(pullDistance(raw))
    }

    const onEnd = (): void => {
      const fire = distanceRef.current >= PULL_THRESHOLD_PX
      reset()
      if (!fire) return
      setRefreshing(true)
      refreshRef.current()
      window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(() => setRefreshing(false), REFRESH_HOLD_MS)
    }

    window.addEventListener('touchstart', onStart, { passive: true })
    window.addEventListener('touchmove', onMove, { passive: false })
    window.addEventListener('touchend', onEnd, { passive: true })
    window.addEventListener('touchcancel', reset, { passive: true })
    return () => {
      window.removeEventListener('touchstart', onStart)
      window.removeEventListener('touchmove', onMove)
      window.removeEventListener('touchend', onEnd)
      window.removeEventListener('touchcancel', reset)
    }
  }, [enabled])

  useEffect(() => () => window.clearTimeout(timerRef.current), [])

  return { phase: pullPhase(distance, refreshing), distance }
}
