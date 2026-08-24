import { describe, expect, it } from 'vitest'
import {
  DRAG_SLOP_PX,
  FRICTION_PER_FRAME,
  MAX_FLING_PX_PER_MS,
  MIN_FLING_PX_PER_MS,
  VELOCITY_WINDOW_MS,
  applyFingerDelta,
  applyWheelDelta,
  bufferCanScroll,
  clampScrollTop,
  COMPACT_MAX_WIDTH_PX,
  decayVelocity,
  flingVelocity,
  isCompactChrome,
  isDrag,
  linesFromPixels,
  maxScrollTop,
  momentumStep,
  momentumStepPixels,
  pageScrollLines,
  pushSample,
  viewportCanScroll,
  wheelDeltaPx
} from './terminalScroll'

describe('linesFromPixels', () => {
  it('converts whole cells without leaving a carry', () => {
    expect(linesFromPixels(60, 20, 0)).toEqual({ lines: 3, carry: 0 })
  })

  it('keeps a sub-line drag as carry instead of dropping it', () => {
    expect(linesFromPixels(9, 20, 0)).toEqual({ lines: 0, carry: 9 })
  })

  it('releases a line once the carry has filled one — the slow-drag case', () => {
    const first = linesFromPixels(9, 20, 0)
    const second = linesFromPixels(9, 20, first.carry)
    const third = linesFromPixels(9, 20, second.carry)
    expect(second).toEqual({ lines: 0, carry: 18 })
    expect(third.lines).toBe(1)
    expect(third.carry).toBeCloseTo(7)
  })

  it('scrolls the other way for a negative delta and carries toward zero', () => {
    expect(linesFromPixels(-25, 20, 0)).toEqual({ lines: -1, carry: -5 })
  })

  it('never leaves a carry that is a whole cell or more', () => {
    const step = linesFromPixels(199.9, 20, 19.5)
    expect(Math.abs(step.carry)).toBeLessThan(20)
  })

  it('refuses to scroll while the cell height is not measurable yet', () => {
    expect(linesFromPixels(100, 0, 4)).toEqual({ lines: 0, carry: 4 })
    expect(linesFromPixels(100, Number.NaN, 4)).toEqual({ lines: 0, carry: 4 })
    expect(linesFromPixels(Number.NaN, 20, 4)).toEqual({ lines: 0, carry: 4 })
  })
})

describe('isDrag', () => {
  it('treats travel below the slop as a tap', () => {
    expect(isDrag(DRAG_SLOP_PX - 0.01)).toBe(false)
    expect(isDrag(0)).toBe(false)
  })

  it('commits to a drag at the slop', () => {
    expect(isDrag(DRAG_SLOP_PX)).toBe(true)
    expect(isDrag(400)).toBe(true)
  })
})

describe('pushSample', () => {
  it('appends in order and keeps samples inside the window', () => {
    const samples = pushSample([{ y: 100, t: 1000 }], { y: 80, t: 1040 })
    expect(samples).toEqual([
      { y: 100, t: 1000 },
      { y: 80, t: 1040 }
    ])
  })

  it('drops samples older than the window so a pause kills the fling', () => {
    const stale = [{ y: 100, t: 1000 }]
    const samples = pushSample(stale, { y: 90, t: 1000 + VELOCITY_WINDOW_MS + 1 })
    expect(samples).toHaveLength(1)
    expect(flingVelocity(samples)).toBe(0)
  })

  it('does not mutate the array it was given', () => {
    const original = [{ y: 100, t: 1000 }]
    pushSample(original, { y: 90, t: 1010 })
    expect(original).toHaveLength(1)
  })
})

describe('flingVelocity', () => {
  it('needs two samples spanning time', () => {
    expect(flingVelocity([])).toBe(0)
    expect(flingVelocity([{ y: 10, t: 1 }])).toBe(0)
    expect(
      flingVelocity([
        { y: 10, t: 5 },
        { y: 90, t: 5 }
      ])
    ).toBe(0)
  })

  it('turns a finger swiping up into positive (newer output) velocity', () => {
    expect(
      flingVelocity([
        { y: 300, t: 1000 },
        { y: 200, t: 1050 }
      ])
    ).toBeCloseTo(2)
  })

  it('turns a finger swiping down into negative (older output) velocity', () => {
    expect(
      flingVelocity([
        { y: 200, t: 1000 },
        { y: 300, t: 1050 }
      ])
    ).toBeCloseTo(-2)
  })

  it('ignores a crawl that should just stop where it was let go', () => {
    expect(
      flingVelocity([
        { y: 300, t: 1000 },
        { y: 299, t: 1080 }
      ])
    ).toBe(0)
  })

  it('clamps an implausible velocity', () => {
    expect(
      flingVelocity([
        { y: 4000, t: 1000 },
        { y: 0, t: 1001 }
      ])
    ).toBe(MAX_FLING_PX_PER_MS)
  })
})

describe('decayVelocity', () => {
  it('applies one frame of friction per frame of time', () => {
    expect(decayVelocity(1, 1000 / 60)).toBeCloseTo(FRICTION_PER_FRAME)
  })

  it('is framerate independent: two half-frames equal one frame', () => {
    const half = decayVelocity(1, 1000 / 120)
    expect(decayVelocity(half, 1000 / 120)).toBeCloseTo(decayVelocity(1, 1000 / 60))
  })

  it('leaves velocity alone when no time passed', () => {
    expect(decayVelocity(2, 0)).toBe(2)
    expect(decayVelocity(2, -5)).toBe(2)
  })
})

describe('momentumStep', () => {
  it('scrolls in the direction of the velocity and decays it', () => {
    const step = momentumStep(2, 1000 / 60, 20, 0)
    expect(step.lines).toBe(1)
    expect(step.velocity).toBeLessThan(2)
    expect(step.velocity).toBeGreaterThan(0)
  })

  it('carries the sub-line remainder until it adds up to a line', () => {
    const first = momentumStep(0.6, 16, 20, 0)
    expect(first.lines).toBe(0)
    expect(first.carry).toBeCloseTo(9.6)
    const second = momentumStep(first.velocity, 16, 20, first.carry)
    expect(second.lines).toBe(0)
    const third = momentumStep(second.velocity, 16, 20, second.carry)
    expect(third.lines).toBe(1)
  })

  it('reports a stop once friction has eaten the fling', () => {
    expect(momentumStep(MIN_FLING_PX_PER_MS, 1000, 20, 0).velocity).toBe(0)
  })

  it('clamps a frame gap from a backgrounded tab', () => {
    const jumped = momentumStep(2, 10_000, 20, 0)
    const oneStep = momentumStep(2, 50, 20, 0)
    expect(jumped).toEqual(oneStep)
  })

  it('always comes to rest, even from the hardest possible flick', () => {
    let velocity = MAX_FLING_PX_PER_MS
    let frames = 0
    while (velocity !== 0 && frames < 1000) {
      velocity = momentumStep(velocity, 1000 / 60, 20, 0).velocity
      frames += 1
    }
    expect(velocity).toBe(0)
    // Roughly 1.3 s of glide at 60 Hz — long enough to cross a screenful,
    // short enough that the buffer is never running away from the reader.
    expect(frames).toBeLessThan(120)
  })
})

describe('pageScrollLines', () => {
  it('keeps two lines of overlap', () => {
    expect(pageScrollLines(24)).toBe(22)
  })

  it('always moves at least one line on a tiny viewport', () => {
    expect(pageScrollLines(2)).toBe(1)
    expect(pageScrollLines(0)).toBe(1)
    expect(pageScrollLines(Number.NaN)).toBe(1)
  })
})

describe('bufferCanScroll', () => {
  it('scrolls a normal buffer that has history above the viewport', () => {
    expect(bufferCanScroll({ alternate: false, baseY: 120 })).toBe(true)
  })

  it('leaves the gesture alone in the alternate screen', () => {
    // A full-screen TUI has no scrollback; taking the drag here spends a
    // preventDefault on a screen that cannot move.
    expect(bufferCanScroll({ alternate: true, baseY: 0 })).toBe(false)
    expect(bufferCanScroll({ alternate: true, baseY: 999 })).toBe(false)
  })

  it('leaves the gesture alone before the first screen has filled', () => {
    expect(bufferCanScroll({ alternate: false, baseY: 0 })).toBe(false)
  })

  it('does not trust a baseY that is not a number', () => {
    expect(bufferCanScroll({ alternate: false, baseY: Number.NaN })).toBe(false)
  })
})

describe('viewportCanScroll', () => {
  it('claims a viewport whose content is taller than the box', () => {
    expect(viewportCanScroll({ scrollHeight: 4000, clientHeight: 320 })).toBe(true)
  })

  it('leaves a flush viewport alone', () => {
    expect(viewportCanScroll({ scrollHeight: 320, clientHeight: 320 })).toBe(false)
    expect(viewportCanScroll({ scrollHeight: 320.4, clientHeight: 320 })).toBe(false)
  })

  it('does not trust non-numbers', () => {
    expect(viewportCanScroll({ scrollHeight: Number.NaN, clientHeight: 320 })).toBe(false)
    expect(viewportCanScroll({ scrollHeight: 4000, clientHeight: Number.NaN })).toBe(false)
  })
})

describe('clampScrollTop / maxScrollTop', () => {
  it('caps at the overflow, never below zero', () => {
    expect(maxScrollTop(4000, 320)).toBe(3680)
    expect(maxScrollTop(200, 320)).toBe(0)
    expect(clampScrollTop(100, 50)).toBe(50)
    expect(clampScrollTop(-4, 50)).toBe(0)
    expect(clampScrollTop(20, 50)).toBe(20)
  })

  it('treats a broken max as nowhere to go', () => {
    expect(clampScrollTop(40, 0)).toBe(0)
    expect(clampScrollTop(40, Number.NaN)).toBe(0)
    expect(clampScrollTop(Number.NaN, 50)).toBe(0)
    expect(maxScrollTop(Number.NaN, 320)).toBe(0)
  })
})

describe('applyFingerDelta', () => {
  it('drags older output in when the finger moves down', () => {
    // Native paper: finger down, content follows, scrollTop shrinks.
    expect(applyFingerDelta(400, 24, 2000)).toEqual({ scrollTop: 376, moved: true })
  })

  it('drags newer output in when the finger moves up', () => {
    expect(applyFingerDelta(400, -24, 2000)).toEqual({ scrollTop: 424, moved: true })
  })

  it('stops at both ends instead of wrapping', () => {
    expect(applyFingerDelta(10, 40, 2000)).toEqual({ scrollTop: 0, moved: true })
    expect(applyFingerDelta(1990, -40, 2000)).toEqual({ scrollTop: 2000, moved: true })
    expect(applyFingerDelta(0, 10, 2000)).toEqual({ scrollTop: 0, moved: false })
    expect(applyFingerDelta(2000, -10, 2000)).toEqual({ scrollTop: 2000, moved: false })
  })

  it('is a no-op for a zero or broken delta', () => {
    expect(applyFingerDelta(400, 0, 2000)).toEqual({ scrollTop: 400, moved: false })
    expect(applyFingerDelta(400, Number.NaN, 2000)).toEqual({ scrollTop: 400, moved: false })
  })
})

describe('applyWheelDelta', () => {
  it('scrolls toward newer output for a positive (down) wheel', () => {
    expect(applyWheelDelta(400, 48, 2000)).toEqual({ scrollTop: 448, moved: true })
  })

  it('scrolls toward older output for a negative (up) wheel', () => {
    expect(applyWheelDelta(400, -48, 2000)).toEqual({ scrollTop: 352, moved: true })
  })

  it('stops at the ends', () => {
    expect(applyWheelDelta(0, -20, 2000).moved).toBe(false)
    expect(applyWheelDelta(2000, 20, 2000).moved).toBe(false)
  })
})

describe('wheelDeltaPx', () => {
  it('passes pixel-mode trackpad deltas through', () => {
    expect(wheelDeltaPx({ deltaY: 12.5, deltaMode: 0 }, 20)).toBe(12.5)
  })

  it('turns line-mode deltas into cell pixels', () => {
    expect(wheelDeltaPx({ deltaY: 3, deltaMode: 1 }, 20)).toBe(60)
    expect(wheelDeltaPx({ deltaY: 3, deltaMode: 1 }, 0)).toBe(48)
  })

  it('turns page-mode deltas into a screenful', () => {
    expect(wheelDeltaPx({ deltaY: 1, deltaMode: 2 }, 20)).toBe(480)
  })

  it('ignores a broken deltaY', () => {
    expect(wheelDeltaPx({ deltaY: Number.NaN, deltaMode: 0 }, 20)).toBe(0)
  })
})

describe('momentumStepPixels', () => {
  it('advances scrollTop in the direction of the velocity', () => {
    const step = momentumStepPixels(2, 1000 / 60, 400, 2000)
    expect(step.scrollTop).toBeCloseTo(400 + 2 * (1000 / 60))
    expect(step.moved).toBe(true)
    expect(step.velocity).toBeLessThan(2)
    expect(step.velocity).toBeGreaterThan(0)
  })

  it('dies at the end of the buffer instead of oscillating', () => {
    const atEnd = momentumStepPixels(2, 16, 2000, 2000)
    expect(atEnd.scrollTop).toBe(2000)
    expect(atEnd.moved).toBe(false)
    expect(atEnd.velocity).toBe(0)
  })

  it('always comes to rest, even from the hardest possible flick', () => {
    let velocity = MAX_FLING_PX_PER_MS
    let scrollTop = 0
    let frames = 0
    while (velocity !== 0 && frames < 1000) {
      const step = momentumStepPixels(velocity, 1000 / 60, scrollTop, 50_000)
      velocity = step.velocity
      scrollTop = step.scrollTop
      frames += 1
    }
    expect(velocity).toBe(0)
    expect(frames).toBeLessThan(120)
    expect(scrollTop).toBeGreaterThan(0)
  })
})

describe('isCompactChrome', () => {
  it('folds on a coarse pointer at any width', () => {
    expect(isCompactChrome({ coarse: true, widthPx: 1280 })).toBe(true)
    expect(isCompactChrome({ coarse: true, widthPx: 390 })).toBe(true)
  })

  it('folds a narrow window even when the pointer is fine', () => {
    // DevTools device mode, a split laptop window, a phone that reports fine.
    expect(isCompactChrome({ coarse: false, widthPx: 390 })).toBe(true)
    expect(isCompactChrome({ coarse: false, widthPx: COMPACT_MAX_WIDTH_PX })).toBe(true)
    expect(isCompactChrome({ coarse: false, widthPx: COMPACT_MAX_WIDTH_PX + 1 })).toBe(false)
    expect(isCompactChrome({ coarse: false, widthPx: 1280 })).toBe(false)
  })
})
