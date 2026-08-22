import { describe, expect, it } from 'vitest'
import {
  decideReveal,
  MAX_ANCESTOR_DEPTH,
  MIN_TARGET_PX,
  REVEAL_MARGIN_PX,
  type AncestorBox,
  type FocusTarget,
  type RevealRequest
} from './revealPolicy'

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
    expect(decideReveal(ask(field({ editable: false }), [DOCUMENT_SCROLLER]))).toBe('not-editable')
  })

  it("ignores xterm's transparent key-capture textarea", () => {
    expect(decideReveal(ask(field({ opacity: '0' }), [DOCUMENT_SCROLLER]))).toBe('decorative')
  })

  it('ignores a field too small to be typed into', () => {
    const tiny = { top: 300, bottom: 300 + MIN_TARGET_PX - 1, width: 2, height: MIN_TARGET_PX - 1 }
    expect(decideReveal(ask(field({ rect: tiny }), [DOCUMENT_SCROLLER]))).toBe('decorative')
  })

  it('ignores a field in a visibility:hidden subtree — the parked overview', () => {
    expect(decideReveal(ask(field({ visibility: 'hidden' }), [DOCUMENT_SCROLLER]))).toBe(
      'not-visible'
    )
    expect(decideReveal(ask(field({ visibility: 'collapse' }), [DOCUMENT_SCROLLER]))).toBe(
      'not-visible'
    )
  })
})

describe('decideReveal — the visible band', () => {
  it('leaves a field that already clears the margin alone', () => {
    const inside = { top: BAND.top + REVEAL_MARGIN_PX, bottom: BAND.bottom - REVEAL_MARGIN_PX }
    const target = field({ rect: { ...inside, width: 300, height: inside.bottom - inside.top } })
    expect(decideReveal(ask(target, [DOCUMENT_SCROLLER]))).toBe('already-visible')
  })

  it('reveals a field the keyboard has covered', () => {
    const covered = { top: 340, bottom: 384, width: 300, height: 44 }
    expect(decideReveal(ask(field({ rect: covered }), [DOCUMENT_SCROLLER]))).toBe('reveal')
  })

  it('reveals a field pushed above the band by an iOS viewport shift', () => {
    const request = {
      target: field({ rect: { top: 4, bottom: 48, width: 300, height: 44 } }),
      band: { top: 40, bottom: 400 },
      ancestors: [DOCUMENT_SCROLLER]
    }
    expect(decideReveal(request)).toBe('reveal')
  })
})

describe('decideReveal — can a scroll actually move it', () => {
  it("skips the terminal composer: fixed overlay, no scrollport above it", () => {
    // input → form.input-bar → .terminal-view (fixed) → #root → body → html.
    const chain = [box(), FIXED_OVERLAY, box(), box(), DOCUMENT_SCROLLER]
    expect(decideReveal(ask(field(), chain))).toBe('pinned')
  })

  it('reveals inside a fixed overlay that is itself a scroller', () => {
    const scrollableOverlay = box({
      position: 'fixed',
      overflowY: 'auto',
      scrollHeight: 2000,
      clientHeight: 320
    })
    expect(decideReveal(ask(field(), [box(), scrollableOverlay, DOCUMENT_SCROLLER]))).toBe('reveal')
  })

  it('reveals via a scroller nested inside a fixed overlay', () => {
    expect(decideReveal(ask(field(), [SCROLLER, FIXED_OVERLAY, DOCUMENT_SCROLLER]))).toBe('reveal')
  })

  it('reveals in the document-scrolled overview', () => {
    expect(decideReveal(ask(field(), [box(), box(), DOCUMENT_SCROLLER]))).toBe('reveal')
  })

  it('reveals when nothing in the chain scrolls yet — the scroll is a harmless no-op', () => {
    expect(decideReveal(ask(field(), [box(), box()]))).toBe('reveal')
  })

  it('does not treat position:sticky as pinned — its scrollport still moves it', () => {
    const sticky = box({ position: 'sticky' })
    expect(decideReveal(ask(field(), [sticky, DOCUMENT_SCROLLER]))).toBe('reveal')
  })

  it('does not count an overflow:hidden box as a scrollport', () => {
    // `App.tsx` freezes <html> this way while the terminal is up; honouring it
    // is what keeps the fix from simply moving the damage one box outwards.
    const frozen = box({ overflowY: 'hidden', scrollHeight: 5200, clientHeight: 640 })
    expect(decideReveal(ask(field(), [box(), FIXED_OVERLAY, frozen]))).toBe('pinned')
  })

  it('does not count a scrollport with nothing to scroll', () => {
    const flush = box({ overflowY: 'auto', scrollHeight: 320, clientHeight: 320 })
    const subpixel = box({ overflowY: 'auto', scrollHeight: 320.5, clientHeight: 320 })
    expect(decideReveal(ask(field(), [flush, FIXED_OVERLAY]))).toBe('pinned')
    expect(decideReveal(ask(field(), [subpixel, FIXED_OVERLAY]))).toBe('pinned')
  })
})

describe('decideReveal — the walk is bounded', () => {
  it('gives up rather than walking an unbounded chain', () => {
    const chain = Array.from({ length: MAX_ANCESTOR_DEPTH + 5 }, () => box())
    expect(decideReveal(ask(field(), chain))).toBe('unproven')
  })

  it('stops consuming ancestors as soon as it has an answer', () => {
    let taken = 0
    function* lazy(): Generator<AncestorBox> {
      for (const entry of [box(), FIXED_OVERLAY, DOCUMENT_SCROLLER]) {
        taken += 1
        yield entry
      }
    }
    expect(decideReveal({ target: field(), band: BAND, ancestors: lazy() })).toBe('pinned')
    expect(taken).toBe(2)
  })

  it('consumes no ancestors at all when the element decides it', () => {
    let taken = 0
    function* lazy(): Generator<AncestorBox> {
      taken += 1
      yield DOCUMENT_SCROLLER
    }
    expect(decideReveal({ target: field({ editable: false }), band: BAND, ancestors: lazy() })).toBe(
      'not-editable'
    )
    expect(taken).toBe(0)
  })
})
