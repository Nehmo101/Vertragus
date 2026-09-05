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
 * and destroys the offset the overlay was built to preserve.
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
 * Submit cluster that must stay in the visible band with the focused field.
 * Composer and answer send live in `.composer-actions` / `.answer-actions`;
 * start and goal-refill primaries live in `.start-actions` / `.goal-actions`.
 * Revealing only the field with a 16 px margin parks that 44 px button under
 * the keyboard. The selector names those clusters — not a random `.primary`.
 */
export const SUBMIT_CLUSTER_SELECTOR =
  '.composer-actions, .answer-actions, .start-actions, .goal-actions'

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

/** Border-box, viewport-relative. */
export interface BoxRect {
  top: number
  bottom: number
  width: number
  height: number
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
  rect: BoxRect
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
  /**
   * Rect of the submit cluster (composer/answer/start/goal-refill actions)
   * that has to stay in the band with the field. Absent when the focused
   * field has no such neighbour — a search box, xterm's helper.
   */
  companion?: BoxRect | null
}

/**
 * The rect the reveal has to keep in the band: the field, unioned with its
 * submit cluster when there is one. Decorative checks still use the field
 * alone — a tiny transparent helper does not become worth revealing because
 * a button happens to sit under it.
 */
export function unionRect(field: BoxRect, companion: BoxRect | null | undefined): BoxRect {
  if (!companion) return field
  const top = Math.min(field.top, companion.top)
  const bottom = Math.max(field.bottom, companion.bottom)
  return {
    top,
    bottom,
    width: Math.max(field.width, companion.width),
    height: bottom - top
  }
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

/**
 * The verdict, plus WHICH box proved it.
 *
 * The index matters as much as the decision. The walk's whole job is to find
 * the one scrollport a scroll should move; handing back only `'reveal'` and
 * letting the caller reach for `scrollIntoView` throws that away, and
 * `scrollIntoView` then scrolls EVERY scrollable ancestor — including the
 * document, which is exactly the box this module exists to keep still. Note
 * that `overflow: hidden` is not a defence there: `scrollIntoView` scrolls a
 * hidden overflow box happily.
 */
export interface RevealVerdict {
  decision: RevealDecision
  /**
   * Index into the ancestor sequence of the scrollport to move, or `null` when
   * there is none to name — either the decision is not `'reveal'`, or the
   * chain ran out in normal flow and the answer is the viewport's own scroll.
   */
  scrollportIndex: number | null
}

const NO_SCROLLPORT = { scrollportIndex: null } as const

export function decideReveal(request: RevealRequest): RevealVerdict {
  const { target, band } = request
  if (!target.editable) return { decision: 'not-editable', ...NO_SCROLLPORT }
  if (target.visibility === 'hidden' || target.visibility === 'collapse') {
    return { decision: 'not-visible', ...NO_SCROLLPORT }
  }
  if (target.opacity === '0') return { decision: 'decorative', ...NO_SCROLLPORT }
  if (target.rect.width < MIN_TARGET_PX || target.rect.height < MIN_TARGET_PX) {
    return { decision: 'decorative', ...NO_SCROLLPORT }
  }
  const rect = unionRect(target.rect, request.companion)
  if (
    rect.top >= band.top + REVEAL_MARGIN_PX &&
    rect.bottom <= band.bottom - REVEAL_MARGIN_PX
  ) {
    return { decision: 'already-visible', ...NO_SCROLLPORT }
  }

  let depth = 0
  for (const box of request.ancestors) {
    if (depth >= MAX_ANCESTOR_DEPTH) return { decision: 'unproven', ...NO_SCROLLPORT }
    // Checked before `position`, so a fixed overlay that is *itself* a
    // scroller still gets its own content revealed.
    if (isScrollport(box)) return { decision: 'reveal', scrollportIndex: depth }
    if (box.position === 'fixed') return { decision: 'pinned', ...NO_SCROLLPORT }
    depth += 1
  }
  // The chain ran out without a fixed ancestor: the element is in normal flow
  // and the document scroll — the overview's own scroller — can reach it.
  return { decision: 'reveal', ...NO_SCROLLPORT }
}

/**
 * How far the proven scrollport has to move to put the field (unioned with
 * its submit cluster, when the caller has one) in the middle of the visible
 * band. Positive means "scroll down" (content moves up).
 *
 * Centring rather than merely clearing the margin: the keyboard is still
 * animating when this lands, the band shrinks a little further after it, and
 * a field parked one pixel above the keys is a field that ends up under them.
 */
export function revealScrollDelta(
  rect: { top: number; bottom: number },
  band: VisibleBand
): number {
  return (rect.top + rect.bottom) / 2 - (band.top + band.bottom) / 2
}

/**
 * ## Measuring the visible band
 *
 * Two quantities come off `visualViewport`, and conflating them is what made
 * the reveal above unreachable in the very state this module was written for.
 *
 * - The **inset** is how much of the LAYOUT viewport is hidden at the bottom.
 *   That is the padding question: document-scrolled content needs that much
 *   room added below it, or its last row cannot be scrolled clear of the keys.
 * - The **displacement** is whether the visible band has moved AT ALL relative
 *   to the layout viewport. That is the trigger question: something just took
 *   screen space, so a field that was visible may not be any more.
 *
 * They differ exactly where iOS differs from Android. Android with
 * `interactive-widget=resizes-content` shrinks the layout viewport too, so
 * both are 0 and nothing needs doing. iOS in its shrink state gives
 * `height < innerHeight, offsetTop === 0` and both are the keyboard's height.
 * But iOS also has a state where it does not shrink the visual viewport and
 * SHIFTS it instead: `height === innerHeight, offsetTop > 0`. There the inset
 * is legitimately 0 — nothing of the layout viewport is hidden below, the
 * shift already carried it into view — while the displacement is `offsetTop`.
 * A trigger built on the inset alone is silent in precisely that state.
 */
export interface ViewportGeometry {
  /** `window.innerHeight` — the layout viewport. */
  innerHeight: number
  /** `visualViewport.height`. */
  height: number
  /** `visualViewport.offsetTop`. */
  offsetTop: number
}

/** How much of the layout viewport is hidden at the bottom — `--keyboard-inset`. */
export function keyboardInsetPx(geometry: ViewportGeometry): number {
  return Math.max(0, geometry.innerHeight - geometry.height - geometry.offsetTop)
}

/**
 * How far the visible band has been displaced inside the layout viewport,
 * counting both a shrink at the bottom and a downward shift. Zero means the
 * visible viewport IS the layout viewport and there is nothing to reveal
 * around.
 */
export function viewportDisplacementPx(geometry: ViewportGeometry): number {
  return keyboardInsetPx(geometry) + Math.max(0, geometry.offsetTop)
}
