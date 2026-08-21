/**
 * Keep the layout glued to the *visible* viewport, and publish that geometry
 * as CSS custom properties on `<html>`.
 *
 * On a phone the software keyboard shrinks `visualViewport` while `100dvh`
 * still counts the hidden half, so a composer or terminal bar sized on the
 * layout viewport ends up under the keys. iOS makes it worse: in several
 * states it does not shrink the visual viewport at all, it *shifts* it
 * (`offsetTop`), and it keeps shifting it while the user scrolls, which is why
 * `visualViewport.scroll` is listened to as carefully as `resize`.
 *
 * ## Published contract — these three are a public API
 *
 * Other sheets size themselves on these, so the names and units are fixed:
 *
 * - `--vv-height`  height of the visible viewport, in `px`. What a
 *                  `position: fixed` full-screen surface should use instead of
 *                  `100dvh` (`terminal.css`).
 * - `--keyboard-inset`  how much of the layout viewport the keyboard covers at
 *                  the bottom, in `px`, `0px` when it is closed. Add it to the
 *                  bottom padding of document-scrolled content so the last row
 *                  can still be reached (`styles.css`).
 * - `--vv-offset-top`  how far the visible viewport has been shifted down
 *                  inside the layout viewport, in `px`, `0px` normally. A
 *                  fixed overlay anchored at `top: 0` sits *above* the visible
 *                  area by exactly this much while iOS is shifting.
 *
 * Fallbacks are declared in `styles.css`; this hook only ever overwrites them,
 * so the page is correct before the first frame and on a browser without
 * `visualViewport`.
 */
import { useEffect } from 'react'

/** Selector for the fields worth keeping above the keyboard. */
const EDITABLE = 'input, textarea, select, [contenteditable="true"]'

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
}

function measure(): Geometry {
  const vv = window.visualViewport
  const height = vv?.height ?? window.innerHeight
  const offsetTop = vv?.offsetTop ?? 0
  return {
    height: Math.round(height),
    // What the layout viewport has that the visible one does not, below it.
    // With `interactive-widget=resizes-content` (Android) the layout viewport
    // shrinks too and this is legitimately 0 — the content is already resized.
    keyboard: Math.max(0, Math.round(window.innerHeight - height - offsetTop)),
    offsetTop: Math.round(offsetTop)
  }
}

/**
 * Scroll the focused field back into the visible viewport. The overview is
 * document-scrolled, so when the keyboard opens over a field near the bottom
 * the browser's own "scroll focused element into view" has already run against
 * the *old*, taller viewport and left the field under the keys.
 */
function revealFocus(geometry: Geometry): void {
  const element = document.activeElement
  if (!(element instanceof HTMLElement) || !element.matches(EDITABLE)) return
  const rect = element.getBoundingClientRect()
  // xterm parks a transparent, near-zero-size textarea at the cursor to
  // receive key events. It matches the selector, it takes focus, and scrolling
  // *it* into view would yank the page under the terminal for no reason.
  if (rect.width < 8 || rect.height < 8 || window.getComputedStyle(element).opacity === '0') {
    return
  }
  const top = geometry.offsetTop
  const bottom = top + geometry.height
  const margin = 16
  if (rect.top >= top + margin && rect.bottom <= bottom - margin) return
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  element.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' })
}

export function useVisualViewport(): void {
  useEffect(() => {
    const root = document.documentElement
    let frame = 0
    let published: Geometry = { height: -1, keyboard: -1, offsetTop: -1 }

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
      // `published.keyboard` is negative only before the first measurement,
      // which excludes a page that loads with the keyboard already up.
      const growing = published.keyboard >= 0 && next.keyboard > published.keyboard
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
      if (published.keyboard > 0) scheduleReveal()
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
