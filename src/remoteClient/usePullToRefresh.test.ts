import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LIVENESS_PROBE_TIMEOUT_MS } from './connection'
import {
  claimsGesture,
  PULL_CLAIM_PX,
  PULL_INDICATOR_PX,
  PULL_REFUSE_SELECTOR,
  PULL_THRESHOLD_PX,
  pullDistance,
  pullGesture,
  pullIndicatorOpacity,
  pullIndicatorShown,
  pullIntent,
  pullLabel,
  pullPhase,
  refreshOutstanding,
  refreshVerdict,
  REFRESH_VERDICT_MS,
  shouldFireRefresh,
  type PullLink
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
    expect(pullPhase(0, 'idle')).toBe('idle')
    expect(pullPhase(PULL_THRESHOLD_PX - 1, 'idle')).toBe('pulling')
    expect(pullPhase(PULL_THRESHOLD_PX, 'idle')).toBe('armed')
  })

  it('lets an in-flight refresh outrank the finger', () => {
    expect(pullPhase(0, 'waiting')).toBe('refreshing')
    expect(pullPhase(PULL_THRESHOLD_PX, 'waiting')).toBe('refreshing')
  })

  it('shows an unanswered pull as its own phase, not as a finished one', () => {
    expect(pullPhase(0, 'unanswered')).toBe('unanswered')
    expect(pullPhase(PULL_THRESHOLD_PX, 'unanswered')).toBe('unanswered')
    expect(pullPhase(0, 'unanswered')).not.toBe(pullPhase(0, 'idle'))
  })

  it('discretises the finger for boundary setState', () => {
    expect(pullGesture(0)).toBe('idle')
    expect(pullGesture(1)).toBe('pulling')
    expect(pullGesture(PULL_THRESHOLD_PX)).toBe('armed')
  })
})

describe('refresh verdict', () => {
  const link = (over: Partial<PullLink> = {}): PullLink => ({
    probing: false,
    ready: true,
    ...over
  })

  it('counts a probe and an unfinished reconnect as the same open question', () => {
    expect(refreshOutstanding(link({ probing: true }))).toBe(true)
    expect(refreshOutstanding(link({ ready: false }))).toBe(true)
    expect(refreshOutstanding(link({ probing: true, ready: false }))).toBe(true)
    expect(refreshOutstanding(link())).toBe(false)
  })

  it('waits while the probe the pull sent is still out', () => {
    expect(refreshVerdict(true, false, link({ probing: true }))).toBe('waiting')
  })

  it('resolves when the probe is answered on a route that stayed up', () => {
    expect(refreshVerdict(true, false, link())).toBe('answered')
  })

  it('resolves a pull that had to reconnect, once it is ready again', () => {
    // A closed socket makes `wake()` reconnect rather than probe; the `hello`
    // that ends it carries the workspace push the pull asked for.
    expect(refreshVerdict(true, false, link({ ready: false }))).toBe('waiting')
    expect(refreshVerdict(true, false, link())).toBe('answered')
  })

  it('does not call a quiet link an answer to a question never asked', () => {
    // The old behaviour, in one line: a pull that reached nothing used to end
    // with the same completed spinner as one that reached the desktop.
    expect(refreshVerdict(false, false, link())).toBe('waiting')
    expect(refreshVerdict(false, true, link())).toBe('unanswered')
  })

  it('convicts a dead route instead of letting the spinner finish', () => {
    // Probe timed out, client fell back to reconnecting, nothing came back.
    expect(refreshVerdict(true, false, link({ ready: false }))).toBe('waiting')
    expect(refreshVerdict(true, true, link({ ready: false }))).toBe('unanswered')
    expect(refreshVerdict(true, true, link({ probing: true }))).toBe('unanswered')
  })

  it('still reports an answer that lands in the same tick as the ceiling', () => {
    expect(refreshVerdict(true, true, link())).toBe('answered')
  })

  it('waits out the window the client itself needs to convict a route', () => {
    // Shorter and the strip would give up on a route the client has not; the
    // probe window plus one liveness tick is when the verdict actually exists.
    expect(REFRESH_VERDICT_MS).toBeGreaterThanOrEqual(LIVENESS_PROBE_TIMEOUT_MS)
  })
})

describe('firing the refresh', () => {
  it('fires on a released pull that reached the threshold', () => {
    expect(shouldFireRefresh(PULL_THRESHOLD_PX, true)).toBe(true)
    expect(shouldFireRefresh(PULL_THRESHOLD_PX - 1, true)).toBe(false)
  })

  it('refuses a gesture the pull no longer owns', () => {
    // Pull 70 px, put a second finger down to pinch, lift. The second
    // touchstart is ineligible, so the pull stops tracking — but the distance
    // it had already travelled used to be read by the touchend anyway, and the
    // list refreshed for a gesture the user abandoned two fingers ago.
    expect(shouldFireRefresh(PULL_THRESHOLD_PX + 6, false)).toBe(false)
    expect(shouldFireRefresh(0, false)).toBe(false)
  })
})

describe('pull label', () => {
  const copy = {
    pullToRefresh: 'Zum Aktualisieren ziehen',
    releaseToRefresh: 'Loslassen zum Aktualisieren',
    refreshing: 'aktualisiere …',
    pullNoAnswer: 'keine Antwort — verbinde neu …'
  }

  it('says nothing at rest and names every other phase', () => {
    expect(pullLabel('idle', copy)).toBeUndefined()
    expect(pullLabel('pulling', copy)).toBe(copy.pullToRefresh)
    expect(pullLabel('armed', copy)).toBe(copy.releaseToRefresh)
    expect(pullLabel('refreshing', copy)).toBe(copy.refreshing)
  })

  it('never signs a pull off as refreshed when nothing answered', () => {
    // It has its own string now: pinning it rules out the word that would be
    // a lie AND the borrowed `reconnecting …`, which was true of the client
    // but silent about the stale list still on the screen.
    expect(pullLabel('unanswered', copy)).toBe(copy.pullNoAnswer)
    expect(pullLabel('unanswered', copy)).not.toBe(copy.refreshing)
  })
})

describe('pull indicator reveal', () => {
  it('stays off-screen at rest and follows the finger in whole pixels', () => {
    expect(pullIndicatorShown('idle', 0)).toBe(0)
    expect(pullIndicatorShown('pulling', 20.4)).toBe(20)
    expect(pullIndicatorShown('pulling', 96)).toBe(PULL_INDICATOR_PX)
    expect(pullIndicatorShown('armed', 96)).toBe(PULL_INDICATOR_PX)
  })

  it('holds the overlay open while the refresh is in flight', () => {
    expect(pullIndicatorShown('refreshing', 0)).toBe(PULL_INDICATOR_PX)
    expect(pullIndicatorOpacity('refreshing', 0)).toBe(1)
  })

  it('keeps the overlay open to say the pull got nothing', () => {
    expect(pullIndicatorShown('unanswered', 0)).toBe(PULL_INDICATOR_PX)
    expect(pullIndicatorOpacity('unanswered', 0)).toBe(1)
  })

  it('fades in with travel and is solid once armed', () => {
    expect(pullIndicatorOpacity('idle', 0)).toBe(0)
    expect(pullIndicatorOpacity('pulling', PULL_INDICATOR_PX / 2)).toBe(0.5)
    expect(pullIndicatorOpacity('armed', PULL_THRESHOLD_PX)).toBe(1)
  })
})

describe('pull intent / axis lock', () => {
  it('stays undecided inside the slop, including at the claim pixel', () => {
    expect(pullIntent(0, 0, 'undecided')).toBe('undecided')
    expect(pullIntent(PULL_CLAIM_PX, 0, 'undecided')).toBe('undecided')
    expect(pullIntent(-PULL_CLAIM_PX, 0, 'undecided')).toBe('undecided')
  })

  it('claims a downward first axis at the top of the document', () => {
    expect(pullIntent(PULL_CLAIM_PX + 0.1, 0, 'undecided')).toBe('pull')
    expect(pullIntent(40, 0, 'undecided')).toBe('pull')
  })

  it('refuses an upward first axis as a list pan, even at scrollY 0', () => {
    expect(pullIntent(-(PULL_CLAIM_PX + 0.1), 0, 'undecided')).toBe('list')
    expect(pullIntent(-40, 0, 'undecided')).toBe('list')
  })

  it('refuses a downward first axis once the document has left the top', () => {
    expect(pullIntent(40, 12, 'undecided')).toBe('list')
  })

  it('treats rubber-band scrollY below zero as still at the top', () => {
    expect(pullIntent(40, -8, 'undecided')).toBe('pull')
  })

  it('never reopens a decision: downward noise then an upward flick is a list pan forever', () => {
    let intent = pullIntent(4, 0, 'undecided')
    expect(intent).toBe('undecided')
    intent = pullIntent(-12, 0, intent)
    expect(intent).toBe('list')
    intent = pullIntent(80, 0, intent)
    expect(intent).toBe('list')
  })

  it('keeps a claimed pull even if the finger later reverses', () => {
    let intent = pullIntent(20, 0, 'undecided')
    expect(intent).toBe('pull')
    intent = pullIntent(-40, 0, intent)
    expect(intent).toBe('pull')
  })

  it('does not lock on a broken delta or scroll position', () => {
    expect(pullIntent(Number.NaN, 0, 'undecided')).toBe('undecided')
    expect(pullIntent(40, Number.NaN, 'undecided')).toBe('undecided')
    expect(pullIntent(40, 0, 'undecided', Number.NaN)).toBe('undecided')
  })

  it('refuses a mostly-horizontal swipe as a list pan, even at scroll top', () => {
    expect(pullIntent(4, 0, 'undecided', 20)).toBe('list')
    expect(pullIntent(12, 0, 'undecided', 40)).toBe('list')
  })

  it('still claims a downward first axis when the horizontal noise is smaller', () => {
    expect(pullIntent(40, 0, 'undecided', 10)).toBe('pull')
  })
})

describe('the pull never claims the document pan', () => {
  const source = readFileSync(fileURLToPath(new URL('./usePullToRefresh.ts', import.meta.url)), 'utf8')

  function onStartBody(): string {
    const start = source.indexOf('const onStart = (event: TouchEvent)')
    if (start < 0) throw new Error('self-check: onStart is gone')
    const end = source.indexOf('\n    function onMove(', start)
    if (end < 0) throw new Error('self-check: onStart has no end')
    return source.slice(start, end)
  }

  function onMoveBody(): string {
    const start = source.indexOf('function onMove(event: TouchEvent)')
    if (start < 0) throw new Error('self-check: onMove is gone')
    const end = source.indexOf('\n    const onEnd', start)
    if (end < 0) throw new Error('self-check: onMove has no end')
    return source.slice(start, end)
  }

  it('finds the listeners it is about to police', () => {
    expect(onStartBody().length).toBeGreaterThan(0)
    expect(onMoveBody().length).toBeGreaterThan(0)
  })

  it('registers every window touch listener as passive', () => {
    expect(source).toContain("window.addEventListener('touchstart', onStart, { passive: true })")
    expect(source).toContain("window.addEventListener('touchmove', onMove, { passive: true })")
    expect(source).toContain("window.addEventListener('touchend', onEnd, { passive: true })")
    expect(source).toContain("window.addEventListener('touchcancel', reset, { passive: true })")
  })

  it('has no preventDefault call and no non-passive listener', () => {
    expect(source).not.toMatch(/\.preventDefault\s*\(/)
    expect(source).not.toMatch(/passive:\s*false/)
  })

  it('does not rebind listeners from inside touchmove', () => {
    expect(onMoveBody()).not.toContain('addEventListener')
    expect(onMoveBody()).not.toContain('removeEventListener')
  })

  it('does not walk computed style on touchstart', () => {
    expect(source).not.toMatch(/getComputedStyle\s*\(/)
    expect(source).toContain('claimsGesture(gestureTarget(event.target))')
    expect(source).toContain('.closest(PULL_REFUSE_SELECTOR)')
    expect(onStartBody()).toContain('window.scrollY <= 0')
  })

  it('paints the overlay through the element, not through distance state', () => {
    expect(source).not.toContain('setDistance')
    expect(source).toContain("setProperty('--pull-shown'")
    expect(source).toContain("setProperty('--pull-opacity'")
    expect(onMoveBody()).toContain('paintIndicator(')
    expect(onMoveBody()).not.toContain('setStage')
    expect(onMoveBody()).not.toContain('setGesture')
    expect(onMoveBody()).toContain('publishGesture(')
  })

  it('fires a tap haptic only when the pull becomes armed', () => {
    expect(source).toContain("if (next === 'armed') haptic('tap')")
    expect(onMoveBody()).not.toContain('haptic(')
  })
})

describe('gesture ownership', () => {
  const tokens = PULL_REFUSE_SELECTOR.split(',').map((part) => part.trim())

  function target(hit: unknown): { closest(selectors: string): unknown } {
    return {
      closest(selectors: string) {
        expect(selectors).toBe(PULL_REFUSE_SELECTOR)
        return hit
      }
    }
  }

  it('lists fields, controls and the scroller marker', () => {
    expect(tokens).toEqual(
      expect.arrayContaining([
        'input',
        'textarea',
        'select',
        'button',
        'a',
        'summary',
        'label'
      ])
    )
    expect(tokens.some((part) => part.includes('contenteditable'))).toBe(true)
    expect(tokens.some((part) => part.includes('data-scroller'))).toBe(true)
  })

  it('leaves an ordinary card to the document', () => {
    expect(claimsGesture(target(null))).toBe(true)
  })

  it('refuses a gesture that starts in a field, control or marked scroller', () => {
    expect(claimsGesture(target({}))).toBe(false)
  })

  it('claims a gesture that starts on nothing at all', () => {
    // `event.target` outside the app — an empty chain is the document's own.
    expect(claimsGesture(null)).toBe(true)
  })
})
