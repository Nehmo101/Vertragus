/**
 * Keep the layout glued to the *visible* viewport, and publish that geometry
 * as CSS custom properties on `<html>`.
 *
 * On a phone the software keyboard shrinks `visualViewport` while `100dvh`
 * still counts the hidden half, so a composer or terminal bar sized on the
 * layout viewport ends up under the keys. iOS makes it worse: in several
 * states it does not shrink the visual viewport at all, it *shifts* it
 * (`offsetTop`), and it keeps shifting it while the user scrolls, which is why
 * `visualViewport.scroll` is listened to as carefully as `resize`. Both states
 * have to arm the reveal below — see `viewportDisplacementPx`, which is the
 * quantity that is non-zero in each of them.
 *
 * ## Published contract — these three are a public API
 *
 * Other sheets size themselves on these, so the names and meanings are fixed.
 * Each is a CSS `<length>`: this hook always writes `px`, and the fallbacks in
 * `styles.css` are whatever states the same thing before any script has run —
 * `--vv-height` falls back to `100dvh`, the other two to `0px`.
 *
 * - `--vv-height`  height of the visible viewport. What a `position: fixed`
 *                  full-screen surface should use instead of `100dvh`
 *                  (`terminal.css`).
 * - `--keyboard-inset`  how much of the layout viewport the keyboard covers at
 *                  the bottom, `0px` when it is closed. Add it to the bottom
 *                  padding of document-scrolled content so the last row can
 *                  still be reached (`styles.css`).
 * - `--vv-offset-top`  how far the visible viewport has been shifted down
 *                  inside the layout viewport, `0px` normally. A fixed overlay
 *                  anchored at `top: 0` sits *above* the visible area by
 *                  exactly this much while iOS is shifting.
 *
 * Fallbacks are declared in `styles.css`; this hook only ever overwrites them,
 * so the page is correct before the first frame and on a browser without
 * `visualViewport`.
 */
import { useEffect } from 'react'
import {
  decideReveal,
  keyboardInsetPx,
  revealScrollDelta,
  viewportDisplacementPx,
  EDITABLE_SELECTOR,
  type AncestorBox
} from './revealPolicy'

/**
 * Quiet period before the focused field is scrolled into view. The keyboard
 * animates open over several frames, so acting on the first growth step would
 * aim at a viewport that is still moving.
 */
const REVEAL_SETTLE_MS = 140

interface Geometry {
  height: number
  keyboard: number
  offsetTop: number
  /** Any displacement of the visible band, shrink or shift — the reveal trigger. */
  displacement: number
}

function measure(): Geometry {
  const vv = window.visualViewport
  const raw = {
    innerHeight: window.innerHeight,
    height: vv?.height ?? window.innerHeight,
    offsetTop: vv?.offsetTop ?? 0
  }
  return {
    height: Math.round(raw.height),
    // What the layout viewport has that the visible one does not, below it.
    // With `interactive-widget=resizes-content` (Android) the layout viewport
    // shrinks too and this is legitimately 0 — the content is already resized.
    // It is also 0 in iOS's shift state, which is why it is NOT the trigger.
    keyboard: Math.round(keyboardInsetPx(raw)),
    offsetTop: Math.round(raw.offsetTop),
    displacement: Math.round(viewportDisplacementPx(raw))
  }
}

/**
 * The focused element's ancestors, nearest first, as `decideReveal` wants
 * them. A generator, so the `getComputedStyle` per step is only paid for the
 * ancestors the decision actually reaches — usually two or three. Each node it
 * yields is recorded in `chain`, so the index the verdict names can be turned
 * back into the element to scroll.
 */
function* ancestorBoxes(element: HTMLElement, chain: HTMLElement[]): Generator<AncestorBox> {
  for (let node = element.parentElement; node !== null; node = node.parentElement) {
    const style = window.getComputedStyle(node)
    chain.push(node)
    yield {
      position: style.position,
      overflowY: style.overflowY,
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight
    }
  }
}

/**
 * Scroll the focused field back into the visible viewport. The overview is
 * document-scrolled, so when the keyboard opens over a field near the bottom
 * the browser's own "scroll focused element into view" has already run against
 * the *old*, taller viewport and left the field under the keys.
 *
 * Every reason NOT to scroll lives in `revealPolicy.ts` — including the one
 * that matters most, that the terminal's composer sits in a `position: fixed`
 * overlay a document scroll cannot move but would scroll the parked overview
 * out from under anyway.
 *
 * The scroll itself is deliberately NOT `scrollIntoView`. That method scrolls
 * every scrollable ancestor, `<html>` included and `overflow: hidden` boxes
 * included, which throws away the one thing the policy just established: which
 * single scrollport can move this element. So the verdict names that box and
 * this moves exactly it — or the viewport, when the chain ended in normal flow
 * and the document scroll is the answer.
 */
function revealFocus(geometry: Geometry): void {
  const element = document.activeElement
  if (!(element instanceof HTMLElement)) return
  const style = window.getComputedStyle(element)
  const rect = element.getBoundingClientRect()
  const band = { top: geometry.offsetTop, bottom: geometry.offsetTop + geometry.height }
  const chain: HTMLElement[] = []
  const verdict = decideReveal({
    target: {
      editable: element.matches(EDITABLE_SELECTOR),
      opacity: style.opacity,
      visibility: style.visibility,
      rect: { top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height }
    },
    band,
    ancestors: ancestorBoxes(element, chain)
  })
  if (verdict.decision !== 'reveal') return
  const delta = revealScrollDelta(rect, band)
  if (Math.round(delta) === 0) return
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const behavior: ScrollBehavior = reduced ? 'auto' : 'smooth'
  const scrollport = verdict.scrollportIndex === null ? undefined : chain[verdict.scrollportIndex]
  if (scrollport) {
    scrollport.scrollTo({ top: scrollport.scrollTop + delta, behavior })
    return
  }
  // No scrollport in the chain: the element is in normal flow, so the viewport
  // is the scroller. `scrollBy` moves that one box and nothing else.
  window.scrollBy({ top: delta, behavior })
}

export function useVisualViewport(): void {
  useEffect(() => {
    const root = document.documentElement
    let frame = 0
    let published: Geometry = { height: -1, keyboard: -1, offsetTop: -1, displacement: -1 }

    let revealTimer = 0
    const scheduleReveal = (): void => {
      if (revealTimer !== 0) window.clearTimeout(revealTimer)
      revealTimer = window.setTimeout(() => {
        revealTimer = 0
        revealFocus(measure())
      }, REVEAL_SETTLE_MS)
    }

    const apply = (): void => {
      const next = measure()
      // `published.displacement` is negative only before the first measurement,
      // which excludes a page that loads with the keyboard already up.
      const growing = published.displacement >= 0 && next.displacement > published.displacement
      if (next.height !== published.height) {
        root.style.setProperty('--vv-height', `${next.height}px`)
      }
      if (next.keyboard !== published.keyboard) {
        root.style.setProperty('--keyboard-inset', `${next.keyboard}px`)
      }
      if (next.offsetTop !== published.offsetTop) {
        root.style.setProperty('--vv-offset-top', `${next.offsetTop}px`)
      }
      published = next
      if (growing) scheduleReveal()
    }

    /**
     * `visualViewport` fires a storm of resize/scroll events through the
     * keyboard animation. Coalescing to one frame keeps that from turning into
     * a style recalculation per event — and writing a property only when its
     * value actually changed keeps it from restarting CSS transitions that
     * depend on these variables.
     */
    const schedule = (): void => {
      if (frame !== 0) return
      frame = window.requestAnimationFrame(() => {
        frame = 0
        apply()
      })
    }

    apply()
    // The keyboard may already be up when a field is focused programmatically
    // or the user tabs between fields; no viewport event follows that.
    const onFocusIn = (): void => {
      if (published.displacement > 0) scheduleReveal()
    }

    const vv = window.visualViewport
    vv?.addEventListener('resize', schedule)
    vv?.addEventListener('scroll', schedule)
    window.addEventListener('resize', schedule)
    window.addEventListener('orientationchange', schedule)
    document.addEventListener('focusin', onFocusIn)
    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame)
      if (revealTimer !== 0) window.clearTimeout(revealTimer)
      vv?.removeEventListener('resize', schedule)
      vv?.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      window.removeEventListener('orientationchange', schedule)
      document.removeEventListener('focusin', onFocusIn)
    }
  }, [])
}
