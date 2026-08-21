import { describe, expect, it } from 'vitest'
import {
  claimsGesture,
  ownsTouchAsField,
  ownsTouchAsScroller,
  pullDistance,
  pullIndicatorHeight,
  pullLabel,
  pullPhase,
  PULL_THRESHOLD_PX,
  type GestureNode
} from './usePullToRefresh'

describe('pull distance', () => {
  it('ignores an upward drag', () => {
    expect(pullDistance(0)).toBe(0)
    expect(pullDistance(-40)).toBe(0)
  })

  it('resists the drag and stops growing', () => {
    expect(pullDistance(40)).toBe(20)
    expect(pullDistance(1000)).toBe(96)
    expect(pullDistance(1000)).toBeGreaterThanOrEqual(PULL_THRESHOLD_PX)
  })
})

describe('pull phase', () => {
  it('arms exactly at the threshold', () => {
    expect(pullPhase(0, false)).toBe('idle')
    expect(pullPhase(PULL_THRESHOLD_PX - 1, false)).toBe('pulling')
    expect(pullPhase(PULL_THRESHOLD_PX, false)).toBe('armed')
  })

  it('lets an in-flight refresh outrank the finger', () => {
    expect(pullPhase(0, true)).toBe('refreshing')
    expect(pullPhase(PULL_THRESHOLD_PX, true)).toBe('refreshing')
  })
})

describe('pull label', () => {
  const copy = {
    pullToRefresh: 'Zum Aktualisieren ziehen',
    releaseToRefresh: 'Loslassen zum Aktualisieren',
    refreshing: 'aktualisiere …'
  }

  it('says nothing at rest and names every other phase', () => {
    expect(pullLabel('idle', copy)).toBeUndefined()
    expect(pullLabel('pulling', copy)).toBe(copy.pullToRefresh)
    expect(pullLabel('armed', copy)).toBe(copy.releaseToRefresh)
    expect(pullLabel('refreshing', copy)).toBe(copy.refreshing)
  })
})

describe('pull indicator height', () => {
  it('follows the finger, in whole pixels', () => {
    expect(pullIndicatorHeight('idle', 0)).toBe(0)
    expect(pullIndicatorHeight('pulling', 20.4)).toBe(20)
    expect(pullIndicatorHeight('armed', 96)).toBe(96)
  })

  it('holds a strip open while the refresh is in flight', () => {
    expect(pullIndicatorHeight('refreshing', 0)).toBe(34)
  })
})

describe('gesture ownership', () => {
  const plain = (over: Partial<GestureNode> = {}): GestureNode => ({
    tagName: 'DIV',
    editable: false,
    overflowX: 'visible',
    overflowY: 'visible',
    scrollWidth: 320,
    clientWidth: 320,
    scrollHeight: 200,
    clientHeight: 200,
    ...over
  })

  it('leaves an ordinary card to the document', () => {
    expect(ownsTouchAsField(plain())).toBe(false)
    expect(ownsTouchAsScroller(plain())).toBe(false)
    expect(claimsGesture([plain(), plain({ tagName: 'MAIN' })])).toBe(true)
  })

  it('refuses a gesture that starts in a field, wherever the page is scrolled', () => {
    expect(ownsTouchAsField(plain({ tagName: 'TEXTAREA' }))).toBe(true)
    expect(ownsTouchAsField(plain({ tagName: 'INPUT' }))).toBe(true)
    expect(ownsTouchAsField(plain({ tagName: 'SELECT' }))).toBe(true)
    expect(ownsTouchAsField(plain({ editable: true }))).toBe(true)
    expect(claimsGesture([plain({ tagName: 'TEXTAREA' })])).toBe(false)
  })

  it('refuses a textarea the user is scrolling internally', () => {
    const textarea = plain({ tagName: 'TEXTAREA', overflowY: 'auto', scrollHeight: 600 })
    expect(claimsGesture([textarea])).toBe(false)
  })

  it('refuses a horizontally scrolling strip', () => {
    const strip = plain({ overflowX: 'auto', scrollWidth: 900, clientWidth: 320 })
    expect(ownsTouchAsScroller(strip)).toBe(true)
    // The finger lands on a key inside the strip, not on the strip itself.
    expect(claimsGesture([plain({ tagName: 'BUTTON' }), strip, plain()])).toBe(false)
  })

  it('refuses a nested vertical scroller', () => {
    const pane = plain({ overflowY: 'scroll', scrollHeight: 900, clientHeight: 200 })
    expect(ownsTouchAsScroller(pane)).toBe(true)
    expect(claimsGesture([pane])).toBe(false)
  })

  it('reads `overlay` as a scroller too', () => {
    expect(
      ownsTouchAsScroller(plain({ overflowX: 'overlay', scrollWidth: 900, clientWidth: 320 }))
    ).toBe(true)
  })

  it('does not mistake clipped overflow for a scroller', () => {
    expect(
      ownsTouchAsScroller(plain({ overflowX: 'hidden', scrollWidth: 900, clientWidth: 320 }))
    ).toBe(false)
    expect(
      ownsTouchAsScroller(plain({ overflowX: 'clip', scrollWidth: 900, clientWidth: 320 }))
    ).toBe(false)
  })

  it('tolerates a subpixel of overflow', () => {
    const rounded = plain({
      overflowX: 'auto',
      scrollWidth: 320.5,
      clientWidth: 320,
      overflowY: 'auto',
      scrollHeight: 200.5,
      clientHeight: 200
    })
    expect(ownsTouchAsScroller(rounded)).toBe(false)
    expect(claimsGesture([rounded])).toBe(true)
  })

  it('claims a gesture that starts on nothing at all', () => {
    // `event.target` outside the app — an empty chain is the document's own.
    expect(claimsGesture([])).toBe(true)
  })
})
