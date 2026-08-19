import { describe, expect, it } from 'vitest'
import {
  PANEL_MARGIN,
  PANEL_MAX_HEIGHT,
  PANEL_WIDTH,
  panelBoundsFromPosition,
  panelPlacement
} from './panelPlacement'

const workArea = { x: 0, y: 0, width: 1920, height: 1080 }

describe('panelPlacement', () => {
  it('docks right-center without stored bounds — the first-run default', () => {
    const placement = panelPlacement(undefined, workArea)
    expect(placement.x).toBe(1920 - PANEL_WIDTH - PANEL_MARGIN)
    expect(placement.height).toBe(PANEL_MAX_HEIGHT)
    expect(placement.y).toBe(Math.round((1080 - PANEL_MAX_HEIGHT) / 2))
  })

  it('restores a stored edge and vertical offset', () => {
    expect(panelPlacement({ edge: 'left', y: 100 }, workArea)).toMatchObject({
      x: PANEL_MARGIN,
      y: 100
    })
    expect(panelPlacement({ edge: 'right', y: 40 }, workArea)).toMatchObject({
      x: 1920 - PANEL_WIDTH - PANEL_MARGIN,
      y: 40
    })
  })

  it('clamps a stored y into the current work area — a shrunken display never strands the panel', () => {
    expect(panelPlacement({ edge: 'left', y: 5_000 }, workArea).y).toBe(1080 - PANEL_MAX_HEIGHT)
    expect(panelPlacement({ edge: 'left', y: -300 }, workArea).y).toBe(0)
  })

  it('respects a work area that does not start at the origin (secondary display)', () => {
    const shifted = { x: 1920, y: 200, width: 1280, height: 800 }
    const placement = panelPlacement({ edge: 'right', y: 250 }, shifted)
    expect(placement.x).toBe(1920 + 1280 - PANEL_WIDTH - PANEL_MARGIN)
    expect(placement.y).toBe(250)
  })

  it('shrinks the panel below its max height on a short display', () => {
    const short = { x: 0, y: 0, width: 1920, height: 600 }
    expect(panelPlacement(undefined, short).height).toBe(600 - PANEL_MARGIN * 2)
  })
})

describe('panelBoundsFromPosition', () => {
  it('derives the edge from which half the panel sits in', () => {
    expect(panelBoundsFromPosition(10, 300, workArea)).toEqual({ edge: 'left', y: 300 })
    expect(panelBoundsFromPosition(1600, 300, workArea)).toEqual({ edge: 'right', y: 300 })
  })

  it('uses the panel center, not its left corner, near the middle', () => {
    const middle = workArea.width / 2
    expect(panelBoundsFromPosition(middle - PANEL_WIDTH, 0, workArea).edge).toBe('left')
    expect(panelBoundsFromPosition(middle, 0, workArea).edge).toBe('right')
  })
})
