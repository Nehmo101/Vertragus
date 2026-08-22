import { describe, expect, it } from 'vitest'
import {
  decideReveal,
  keyboardInsetPx,
  revealScrollDelta,
  viewportDisplacementPx,
  MAX_ANCESTOR_DEPTH,
  MIN_TARGET_PX,
  REVEAL_MARGIN_PX,
  type AncestorBox,
  type FocusTarget,
  type RevealDecision,
  type RevealRequest
} from './revealPolicy'

/** The verdict's reason alone, where the scrollport it names is not the point. */
function decisionOf(request: RevealRequest): RevealDecision {
  return decideReveal(request).decision
}

/** A phone-sized band with the keyboard up: 320 px of screen left. */
const BAND = { top: 0, bottom: 320 }

/** An ordinary text field sitting just above the keyboard line. */
function field(overrides: Partial<FocusTarget> = {}): FocusTarget {
  return {
    editable: true,
    opacity: '1',
    visibility: 'visible',
    rect: { top: 264, bottom: 308, width: 300, height: 44 },
    ...overrides
  }
}

function box(overrides: Partial<AncestorBox> = {}): AncestorBox {
  return { position: 'static', overflowY: 'visible', scrollHeight: 0, clientHeight: 0, ...overrides }
}

/** `overflow-y: auto` with more content than it can show. */
const SCROLLER = box({ overflowY: 'auto', scrollHeight: 4000, clientHeight: 300 })
/** The terminal overlay: fixed, and explicitly not a scroller. */
const FIXED_OVERLAY = box({ position: 'fixed', overflowY: 'hidden', scrollHeight: 320, clientHeight: 320 })
/** `<html>` while the overview owns the scroll. */
const DOCUMENT_SCROLLER = box({ overflowY: 'auto', scrollHeight: 5200, clientHeight: 640 })

function ask(target: FocusTarget, ancestors: AncestorBox[]): RevealRequest {
  return { target, band: BAND, ancestors }
}

describe('decideReveal — what is worth revealing', () => {
  it('ignores focus that is not on a field', () => {
    expect(decisionOf(ask(field({ editable: false }), [DOCUMENT_SCROLLER]))).toBe('not-editable')
  })

  it("ignores xterm's transparent key-capture textarea", () => {
    expect(decisionOf(ask(field({ opacity: '0' }), [DOCUMENT_SCROLLER]))).toBe('decorative')
  })

  it('ignores a field too small to be typed into', () => {
    const tiny = { top: 300, bottom: 300 + MIN_TARGET_PX - 1, width: 2, height: MIN_TARGET_PX - 1 }
    expect(decisionOf(ask(field({ rect: tiny }), [DOCUMENT_SCROLLER]))).toBe('decorative')
  })

  it('ignores a field in a visibility:hidden subtree — the parked overview', () => {
    expect(decisionOf(ask(field({ visibility: 'hidden' }), [DOCUMENT_SCROLLER]))).toBe(
      'not-visible'
    )
    expect(decisionOf(ask(field({ visibility: 'collapse' }), [DOCUMENT_SCROLLER]))).toBe(
      'not-visible'
    )
  })
})

describe('decideReveal — the visible band', () => {
  it('leaves a field that already clears the margin alone', () => {
    const inside = { top: BAND.top + REVEAL_MARGIN_PX, bottom: BAND.bottom - REVEAL_MARGIN_PX }
    const target = field({ rect: { ...inside, width: 300, height: inside.bottom - inside.top } })
    expect(decisionOf(ask(target, [DOCUMENT_SCROLLER]))).toBe('already-visible')
  })

  it('reveals a field the keyboard has covered', () => {
    const covered = { top: 340, bottom: 384, width: 300, height: 44 }
    expect(decisionOf(ask(field({ rect: covered }), [DOCUMENT_SCROLLER]))).toBe('reveal')
  })

  it('reveals a field pushed above the band by an iOS viewport shift', () => {
    const request = {
      target: field({ rect: { top: 4, bottom: 48, width: 300, height: 44 } }),
      band: { top: 40, bottom: 400 },
      ancestors: [DOCUMENT_SCROLLER]
    }
    expect(decisionOf(request)).toBe('reveal')
  })
})

describe('decideReveal — can a scroll actually move it', () => {
  it("skips the terminal composer: fixed overlay, no scrollport above it", () => {
    // input → form.input-bar → .terminal-view (fixed) → #root → body → html.
    const chain = [box(), FIXED_OVERLAY, box(), box(), DOCUMENT_SCROLLER]
    expect(decisionOf(ask(field(), chain))).toBe('pinned')
  })

  it('reveals inside a fixed overlay that is itself a scroller', () => {
    const scrollableOverlay = box({
      position: 'fixed',
      overflowY: 'auto',
      scrollHeight: 2000,
      clientHeight: 320
    })
    expect(decisionOf(ask(field(), [box(), scrollableOverlay, DOCUMENT_SCROLLER]))).toBe('reveal')
  })

  it('reveals via a scroller nested inside a fixed overlay', () => {
    expect(decisionOf(ask(field(), [SCROLLER, FIXED_OVERLAY, DOCUMENT_SCROLLER]))).toBe('reveal')
  })

  it('reveals in the document-scrolled overview', () => {
    expect(decisionOf(ask(field(), [box(), box(), DOCUMENT_SCROLLER]))).toBe('reveal')
  })

  it('reveals when nothing in the chain scrolls yet — the scroll is a harmless no-op', () => {
    expect(decisionOf(ask(field(), [box(), box()]))).toBe('reveal')
  })

  it('does not treat position:sticky as pinned — its scrollport still moves it', () => {
    const sticky = box({ position: 'sticky' })
    expect(decisionOf(ask(field(), [sticky, DOCUMENT_SCROLLER]))).toBe('reveal')
  })

  it('does not count an overflow:hidden box as a scrollport', () => {
    // `App.tsx` freezes <html> this way while the terminal is up; honouring it
    // is what keeps the fix from simply moving the damage one box outwards.
    const frozen = box({ overflowY: 'hidden', scrollHeight: 5200, clientHeight: 640 })
    expect(decisionOf(ask(field(), [box(), FIXED_OVERLAY, frozen]))).toBe('pinned')
  })

  it('does not count a scrollport with nothing to scroll', () => {
    const flush = box({ overflowY: 'auto', scrollHeight: 320, clientHeight: 320 })
    const subpixel = box({ overflowY: 'auto', scrollHeight: 320.5, clientHeight: 320 })
    expect(decisionOf(ask(field(), [flush, FIXED_OVERLAY]))).toBe('pinned')
    expect(decisionOf(ask(field(), [subpixel, FIXED_OVERLAY]))).toBe('pinned')
  })
})

describe('decideReveal — the walk is bounded', () => {
  it('gives up rather than walking an unbounded chain', () => {
    const chain = Array.from({ length: MAX_ANCESTOR_DEPTH + 5 }, () => box())
    expect(decisionOf(ask(field(), chain))).toBe('unproven')
  })

  it('stops consuming ancestors as soon as it has an answer', () => {
    let taken = 0
    function* lazy(): Generator<AncestorBox> {
      for (const entry of [box(), FIXED_OVERLAY, DOCUMENT_SCROLLER]) {
        taken += 1
        yield entry
      }
    }
    expect(decisionOf({ target: field(), band: BAND, ancestors: lazy() })).toBe('pinned')
    expect(taken).toBe(2)
  })

  it('consumes no ancestors at all when the element decides it', () => {
    let taken = 0
    function* lazy(): Generator<AncestorBox> {
      taken += 1
      yield DOCUMENT_SCROLLER
    }
    expect(decisionOf({ target: field({ editable: false }), band: BAND, ancestors: lazy() })).toBe(
      'not-editable'
    )
    expect(taken).toBe(0)
  })
})

/*
 * The index is half the answer. `scrollIntoView` scrolls every scrollable
 * ancestor — `<html>` included, and an `overflow: hidden` box included — which
 * is precisely the damage this module was written to stop, so a verdict of
 * 'reveal' has to say WHICH box may move.
 */
describe('decideReveal — which box the caller may scroll', () => {
  it('names the nested scroller, not the document, inside a fixed overlay', () => {
    // The chain that breaks a bare scrollIntoView: scrolling index 0 keeps the
    // scroll inside the overlay; scrolling <html> at index 2 as well would
    // throw away the document offset the overlay exists to preserve.
    const verdict = decideReveal(ask(field(), [SCROLLER, FIXED_OVERLAY, DOCUMENT_SCROLLER]))
    expect(verdict).toEqual({ decision: 'reveal', scrollportIndex: 0 })
  })

  it('names the document scroller when that is what the walk found', () => {
    const verdict = decideReveal(ask(field(), [box(), box(), DOCUMENT_SCROLLER]))
    expect(verdict).toEqual({ decision: 'reveal', scrollportIndex: 2 })
  })

  it('names a fixed overlay that is its own scroller', () => {
    const scrollableOverlay = box({
      position: 'fixed',
      overflowY: 'auto',
      scrollHeight: 2000,
      clientHeight: 320
    })
    expect(decideReveal(ask(field(), [box(), scrollableOverlay])).scrollportIndex).toBe(1)
  })

  it('names nothing when the chain ends in normal flow — the viewport is the scroller', () => {
    expect(decideReveal(ask(field(), [box(), box()]))).toEqual({
      decision: 'reveal',
      scrollportIndex: null
    })
  })

  it('names nothing for every verdict that is not a reveal', () => {
    for (const request of [
      ask(field({ editable: false }), [SCROLLER]),
      ask(field({ opacity: '0' }), [SCROLLER]),
      ask(field({ visibility: 'hidden' }), [SCROLLER]),
      ask(field(), [box(), FIXED_OVERLAY, DOCUMENT_SCROLLER])
    ]) {
      expect(decideReveal(request).scrollportIndex).toBeNull()
    }
  })
})

describe('revealScrollDelta', () => {
  it('centres the field in the band', () => {
    // Field at 264-308 in a 0-320 band: centre 286 against 160, so the
    // scrollport moves 126 px down and the field lands in the middle.
    expect(revealScrollDelta({ top: 264, bottom: 308 }, BAND)).toBe(126)
  })

  it('goes the other way for a field above the band — the iOS shift case', () => {
    expect(revealScrollDelta({ top: 4, bottom: 48 }, { top: 40, bottom: 400 })).toBe(-194)
  })

  it('asks for nothing when the field is already centred', () => {
    expect(revealScrollDelta({ top: 140, bottom: 180 }, BAND)).toBe(0)
  })
})

/*
 * S1: the reveal has to arm in BOTH of iOS's states. The bug this pins is that
 * the keyboard inset — the padding quantity — is zero in the state iOS reaches
 * by shifting rather than shrinking, so a trigger built on it is silent in
 * exactly the state the hook's own documentation was written about.
 */
describe('viewport geometry — when the visible band has moved', () => {
  const KEYBOARD = 336

  it('reads a shrunk visual viewport as both an inset and a displacement', () => {
    const shrunk = { innerHeight: 800, height: 800 - KEYBOARD, offsetTop: 0 }
    expect(keyboardInsetPx(shrunk)).toBe(KEYBOARD)
    expect(viewportDisplacementPx(shrunk)).toBe(KEYBOARD)
  })

  it('sees a shifted, unshrunk viewport that the inset alone reports as nothing', () => {
    // iOS: height === innerHeight, offsetTop > 0. The inset is legitimately 0
    // — nothing of the layout viewport is hidden below — but the band HAS
    // moved, so the reveal must still arm.
    const shifted = { innerHeight: 800, height: 800, offsetTop: KEYBOARD }
    expect(keyboardInsetPx(shifted)).toBe(0)
    expect(viewportDisplacementPx(shifted)).toBe(KEYBOARD)
  })

  it('handles the mixed state — part shrunk, part shifted', () => {
    const mixed = { innerHeight: 800, height: 600, offsetTop: 80 }
    expect(keyboardInsetPx(mixed)).toBe(120)
    expect(viewportDisplacementPx(mixed)).toBe(200)
  })

  it('reports nothing at all when the visible viewport IS the layout viewport', () => {
    // Android with interactive-widget=resizes-content, and every desktop.
    const flush = { innerHeight: 800, height: 800, offsetTop: 0 }
    expect(keyboardInsetPx(flush)).toBe(0)
    expect(viewportDisplacementPx(flush)).toBe(0)
  })

  it('never goes negative on a visual viewport taller than the layout one', () => {
    const overscrolled = { innerHeight: 800, height: 820, offsetTop: 0 }
    expect(keyboardInsetPx(overscrolled)).toBe(0)
    expect(viewportDisplacementPx(overscrolled)).toBe(0)
  })
})
