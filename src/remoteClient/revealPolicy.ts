/**
 * Whether the focused field is worth scrolling into view at all — as a pure
 * function over facts about the element and its ancestor chain, so the whole
 * decision can be exercised in plain Node against a stubbed tree.
 *
 * `useVisualViewport.ts` owns the wiring: it reads the facts off the DOM and
 * acts on the verdict. This module owns the judgement, because the judgement
 * is where the damage was.
 *
 * ## Why a scroll can be the wrong answer
 *
 * The overview scrolls the DOCUMENT, and `App.tsx` deliberately leaves it
 * mounted under the terminal (`visibility: hidden`) so that the reader's scroll
 * offset, every expanded card and every draft survive the round trip. The
 * terminal itself is a `position: fixed` overlay.
 *
 * So when the keyboard opens over the terminal's composer, the old rule
 * reached for `scrollIntoView({ block: 'center' })` on an input that lives
 * inside that fixed overlay. A fixed box does not move when the document
 * scrolls — the browser cannot bring the input any closer — but it scrolls the
 * document anyway, by roughly the centering delta. The reveal achieves nothing
 * and destroys the offset the overlay was built to preserve (and, on iOS,
 * perturbs `--vv-offset-top` while it is at it).
 *
 * The honest predicate is therefore not "is this element in a fixed subtree"
 * but **"is there a scrollport above this element that a scroll could actually
 * move it inside of"**:
 *
 * - A scrollable ancestor found while walking up is such a scrollport, and
 *   scrolling it moves the element relative to the viewport. Reveal.
 *   This includes a scrollable ancestor found *inside* a fixed overlay — the
 *   terminal's scrollback is one — where the scroll stays inside the overlay
 *   and never touches the document. A "fixed ⇒ never reveal" rule would get
 *   that case wrong.
 * - Reaching a `position: fixed` ancestor without having found one means the
 *   only scrollport left is the viewport, and the viewport cannot move a fixed
 *   box. Skip.
 * - `position: sticky` is NOT a stop. A sticky box is in flow and its
 *   scrollport does move it, up to the offset it pins at; the worst case is a
 *   scroll that helps less than asked for, not one that moves the wrong thing.
 *
 * `overflow: hidden` is deliberately not counted as a scrollport even though
 * `scrollIntoView` will happily scroll one. It is what an author writes to say
 * "this box does not scroll" — `App.tsx` sets it on `<html>` to freeze the
 * list while the terminal is up — and honouring that is the difference between
 * this rule fixing the bug and merely relocating it.
 */

/** Fields worth keeping above the keyboard. Applied by the caller. */
export const EDITABLE_SELECTOR = 'input, textarea, select, [contenteditable="true"]'

/**
 * Below this, an "input" is not something a human is typing into: xterm parks
 * a transparent, near-zero-size textarea at the cursor to receive key events.
 */
export const MIN_TARGET_PX = 8

/** How much clear space the field wants above and below before it counts as visible. */
export const REVEAL_MARGIN_PX = 16

/**
 * Sub-pixel layout leaves most boxes a fraction of a pixel of "scrollable"
 * distance they cannot really use.
 */
export const SCROLL_SLACK_PX = 1

/**
 * Ancestors examined before the walk gives up. Cost is not the constraint —
 * the whole decision sits behind a 140 ms debounce — but an unbounded
 * `getComputedStyle` loop over a hostile tree is still a loop worth bounding,
 * and any chain this long has stopped being evidence of anything.
 */
export const MAX_ANCESTOR_DEPTH = 64

/** Facts about one ancestor box. Names match the DOM they are read from. */
export interface AncestorBox {
  /** Computed `position`. */
  position: string
  /** Computed `overflow-y`. */
  overflowY: string
  /** `element.scrollHeight`. */
  scrollHeight: number
  /** `element.clientHeight`. */
  clientHeight: number
}

/** Facts about the focused element itself. */
export interface FocusTarget {
  /** `element.matches(EDITABLE_SELECTOR)`. */
  editable: boolean
  /** Computed `opacity`, as a string — `'0'` is the xterm helper. */
  opacity: string
  /** Computed `visibility` — inherited, so the element's own value is enough. */
  visibility: string
  /** Border-box rect, viewport-relative. */
  rect: { top: number; bottom: number; width: number; height: number }
}

/** The band of the screen the keyboard has not covered, viewport-relative. */
export interface VisibleBand {
  top: number
  bottom: number
}

export interface RevealRequest {
  target: FocusTarget
  band: VisibleBand
  /**
   * Ancestors, nearest first, up to and including the document element.
   * An `Iterable` rather than an array so the caller can generate them lazily:
   * the walk usually stops after two or three, and each step costs a
   * `getComputedStyle`. Tests pass a plain array.
   */
  ancestors: Iterable<AncestorBox>
}

/**
 * The verdict, with its reason. Only `'reveal'` asks for a scroll; every other
 * value is a distinct thing that was checked, which is what makes the tests
 * and a future bug report legible.
 */
export type RevealDecision =
  | 'reveal'
  /** Not a field: focus is on a button, a link or the body. */
  | 'not-editable'
  /** In a `visibility: hidden` subtree — the overview parked under the terminal. */
  | 'not-visible'
  /** Too small or fully transparent: xterm's key-capture textarea. */
  | 'decorative'
  /** Already comfortably inside the band; a scroll would only jitter it. */
  | 'already-visible'
  /** In a fixed subtree with no scrollport that could move it. */
  | 'pinned'
  /** The ancestor walk hit its bound without proving a scroll would help. */
  | 'unproven'

/** Whether scrolling this box would move its contents. */
function isScrollport(box: AncestorBox): boolean {
  if (box.overflowY !== 'auto' && box.overflowY !== 'scroll' && box.overflowY !== 'overlay') {
    return false
  }
  return box.scrollHeight - box.clientHeight > SCROLL_SLACK_PX
}

export function decideReveal(request: RevealRequest): RevealDecision {
  const { target, band } = request
  if (!target.editable) return 'not-editable'
  if (target.visibility === 'hidden' || target.visibility === 'collapse') return 'not-visible'
  if (target.opacity === '0') return 'decorative'
  if (target.rect.width < MIN_TARGET_PX || target.rect.height < MIN_TARGET_PX) return 'decorative'
  if (
    target.rect.top >= band.top + REVEAL_MARGIN_PX &&
    target.rect.bottom <= band.bottom - REVEAL_MARGIN_PX
  ) {
    return 'already-visible'
  }

  let depth = 0
  for (const box of request.ancestors) {
    if (depth >= MAX_ANCESTOR_DEPTH) return 'unproven'
    depth += 1
    // Checked before `position`, so a fixed overlay that is *itself* a
    // scroller still gets its own content revealed.
    if (isScrollport(box)) return 'reveal'
    if (box.position === 'fixed') return 'pinned'
  }
  // The chain ran out without a fixed ancestor: the element is in normal flow
  // and the document scroll — the overview's own scroller — can reach it.
  return 'reveal'
}
