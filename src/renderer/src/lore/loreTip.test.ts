import { describe, expect, it } from 'vitest'
import { loreBlurb } from '@shared/lore'
import { workspacePlaceBlurb } from '@shared/workspaceNames'
import {
  loreTipPlacement,
  LORE_TIP_ESTIMATED_HEIGHT,
  LORE_TIP_GAP,
  LORE_TIP_MARGIN,
  LORE_TIP_WIDTH
} from './loreTip'

/** The panel, roughly: 280 wide, a tall screen edge. */
const PANEL = { width: 280, height: 900 }

function trigger(top: number, left = 20, width = 90, height = 16): {
  left: number
  right: number
  top: number
  bottom: number
} {
  return { left, right: left + width, top, bottom: top + height }
}

describe('loreTipPlacement', () => {
  it('sits under the name it belongs to, left-aligned with it', () => {
    const place = loreTipPlacement(trigger(120), PANEL)
    expect(place.left).toBe(20)
    // Directly under the trigger's bottom edge, one gap away.
    expect(place.top).toBe(trigger(120).bottom + LORE_TIP_GAP)
    expect(place.above).toBe(false)
  })

  it('never hangs over the window edge — a window is not a screen', () => {
    // A name far to the right of a narrow panel: the card slides back in
    // rather than being clipped in half by the window bounds.
    const place = loreTipPlacement(trigger(200, 210), PANEL)
    expect(place.left).toBe(PANEL.width - LORE_TIP_WIDTH - LORE_TIP_MARGIN)
    expect(place.left + place.width).toBeLessThanOrEqual(PANEL.width - LORE_TIP_MARGIN)
  })

  it('narrows itself when the window is narrower than the card', () => {
    const place = loreTipPlacement(trigger(40), { width: 180, height: 400 })
    expect(place.width).toBe(180 - 2 * LORE_TIP_MARGIN)
    expect(place.left).toBeGreaterThanOrEqual(LORE_TIP_MARGIN)
    expect(place.left + place.width).toBeLessThanOrEqual(180 - LORE_TIP_MARGIN)
  })

  it('flips above the name when the bottom of the window is in the way', () => {
    const place = loreTipPlacement(trigger(PANEL.height - 30), PANEL)
    expect(place.above).toBe(true)
    expect(place.top).toBeLessThan(PANEL.height - 30)
    expect(place.top).toBeGreaterThanOrEqual(LORE_TIP_MARGIN)
  })

  it('stays below when below is merely tight — no jumping on two pixels', () => {
    // Room below is short of the card, but there is even less room above.
    const place = loreTipPlacement(trigger(30), { width: 280, height: 120 })
    expect(place.above).toBe(false)
  })

  it('uses the measured height once there is one', () => {
    const short = loreTipPlacement(trigger(PANEL.height - 120), PANEL, 40)
    const tall = loreTipPlacement(trigger(PANEL.height - 120), PANEL, 300)
    expect(short.above).toBe(false)
    expect(tall.above).toBe(true)
  })

  it('keeps the card inside the window even when it is taller than the room', () => {
    const place = loreTipPlacement(trigger(10), { width: 280, height: 60 }, 400)
    expect(place.top).toBe(LORE_TIP_MARGIN)
    expect(place.left).toBeGreaterThanOrEqual(LORE_TIP_MARGIN)
  })

  it('defaults to an estimate that is a plausible two-line card', () => {
    expect(LORE_TIP_ESTIMATED_HEIGHT).toBeGreaterThan(40)
    expect(loreTipPlacement(trigger(100), PANEL)).toEqual(
      loreTipPlacement(trigger(100), PANEL, LORE_TIP_ESTIMATED_HEIGHT)
    )
  })
})

describe('the names the card is for', () => {
  it('answers for the places and figures the user actually sees', () => {
    // The three the report named, end to end through the shared rosters.
    expect(workspacePlaceBlurb('Limbo')).toMatch(/Kreis/)
    expect(workspacePlaceBlurb('Inferno')).toMatch(/Hölle/)
    expect(loreBlurb('Fortuna')).toMatch(/Glücksgöttin/)
    // …and through the allocator's suffixes, which is what a second workspace
    // or a second agent of the same name is called.
    expect(workspacePlaceBlurb('Inferno II')).toBe(workspacePlaceBlurb('Inferno'))
    expect(loreBlurb('Fortuna 2')).toBe(loreBlurb('Fortuna'))
  })

  it('has nothing to say about a name nobody named', () => {
    expect(loreBlurb('Eigenbau')).toBeUndefined()
    expect(workspacePlaceBlurb('Eigenbau')).toBeUndefined()
  })
})
