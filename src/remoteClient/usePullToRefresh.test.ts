import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LIVENESS_PROBE_TIMEOUT_MS } from './connection'
import {
  claimsGesture,
  ownsTouchAsControl,
  ownsTouchAsField,
  ownsTouchAsScroller,
  PULL_CLAIM_PX,
  pullDistance,
  pullIndicatorHeight,
  pullIntent,
  pullLabel,
  pullPhase,
  PULL_THRESHOLD_PX,
  refreshOutstanding,
  refreshVerdict,
  REFRESH_VERDICT_MS,
  shouldFireRefresh,
  shouldPreventPullMove,
  type GestureNode,
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

describe('pull indicator height', () => {
  it('follows the finger, in whole pixels', () => {
    expect(pullIndicatorHeight('idle', 0)).toBe(0)
    expect(pullIndicatorHeight('pulling', 20.4)).toBe(20)
    expect(pullIndicatorHeight('armed', 96)).toBe(96)
  })

  it('holds a strip open while the refresh is in flight', () => {
    expect(pullIndicatorHeight('refreshing', 0)).toBe(34)
  })

  it('keeps the strip open to say the pull got nothing', () => {
    expect(pullIndicatorHeight('unanswered', 0)).toBe(34)
  })
})

describe('pull intent / axis lock', () => {
  it('stays undecided inside the slop, including at the claim pixel', () => {
    expect(pullIntent(0, 0, 'undecided')).toBe('undecided')
    expect(pullIntent(PULL_CLAIM_PX, 0, 'undecided')).toBe('undecided')
    expect(pullIntent(-PULL_CLAIM_PX, 0, 'undecided')).toBe('undecided')
    expect(shouldPreventPullMove('undecided')).toBe(false)
  })

  it('claims a downward first axis at the top of the document', () => {
    expect(pullIntent(PULL_CLAIM_PX + 0.1, 0, 'undecided')).toBe('pull')
    expect(pullIntent(40, 0, 'undecided')).toBe('pull')
    expect(shouldPreventPullMove('pull')).toBe(true)
  })

  it('refuses an upward first axis as a list pan, even at scrollY 0', () => {
    expect(pullIntent(-(PULL_CLAIM_PX + 0.1), 0, 'undecided')).toBe('list')
    expect(pullIntent(-40, 0, 'undecided')).toBe('list')
    expect(shouldPreventPullMove('list')).toBe(false)
  })

  it('refuses a downward first axis once the document has left the top', () => {
    expect(pullIntent(40, 12, 'undecided')).toBe('list')
    expect(shouldPreventPullMove(pullIntent(40, 12, 'undecided'))).toBe(false)
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
    expect(shouldPreventPullMove(intent)).toBe(false)
  })

  it('keeps a claimed pull even if the finger later reverses', () => {
    let intent = pullIntent(20, 0, 'undecided')
    expect(intent).toBe('pull')
    intent = pullIntent(-40, 0, intent)
    expect(intent).toBe('pull')
    expect(shouldPreventPullMove(intent)).toBe(true)
  })

  it('does not lock on a broken delta or scroll position', () => {
    expect(pullIntent(Number.NaN, 0, 'undecided')).toBe('undecided')
    expect(pullIntent(40, Number.NaN, 'undecided')).toBe('undecided')
    expect(pullIntent(40, 0, 'undecided', Number.NaN)).toBe('undecided')
  })

  it('refuses a mostly-horizontal swipe as a list pan, even at scroll top', () => {
    expect(pullIntent(4, 0, 'undecided', 20)).toBe('list')
    expect(pullIntent(12, 0, 'undecided', 40)).toBe('list')
    expect(shouldPreventPullMove(pullIntent(6, 0, 'undecided', 30))).toBe(false)
  })

  it('still claims a downward first axis when the horizontal noise is smaller', () => {
    expect(pullIntent(40, 0, 'undecided', 10)).toBe('pull')
    expect(shouldPreventPullMove(pullIntent(40, 0, 'undecided', 10))).toBe(true)
  })
})

describe('cancelable touchmove is armed at eligible start, not mid-move', () => {
  const source = readFileSync(fileURLToPath(new URL('./usePullToRefresh.ts', import.meta.url)), 'utf8')

  function helper(name: string): string {
    const start = source.indexOf(`function ${name}(`)
    if (start < 0) throw new Error(`self-check: ${name} is gone`)
    const next = source.indexOf('\n    function ', start + 1)
    const fallback = source.indexOf('\n    const onStart', start + 1)
    const end = next > 0 && (fallback < 0 || next < fallback) ? next : fallback
    if (end < 0) throw new Error(`self-check: ${name} has no end`)
    return source.slice(start, end)
  }

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

  it('finds the arm/disarm helpers it is about to police', () => {
    expect(helper('armCancelableMove')).toContain('onCancelableMove')
    expect(helper('disarmCancelableMove')).toContain('onCancelableMove')
    expect(onStartBody().length).toBeGreaterThan(0)
    expect(onMoveBody().length).toBeGreaterThan(0)
  })

  it('registers the overview touchmove as passive', () => {
    expect(source).toContain("window.addEventListener('touchmove', onMove, { passive: true })")
    expect(source).toContain("window.addEventListener('touchstart', onStart, { passive: true })")
  })

  it('does not rebind the lifetime listener from inside touchmove', () => {
    expect(source).not.toContain('claimNonPassive')
    expect(source).not.toContain('releaseNonPassive')
    expect(onMoveBody()).not.toContain('addEventListener')
    expect(onMoveBody()).not.toContain('removeEventListener')
    expect(onMoveBody()).not.toContain('armCancelableMove')
    expect(onMoveBody()).not.toContain('preventDefault')
  })

  it('arms the cancelable listener from eligible touchstart, before the first move', () => {
    expect(helper('armCancelableMove')).toContain('{ passive: false }')
    expect(helper('disarmCancelableMove')).not.toContain('addEventListener')
    expect(onStartBody()).toContain('armCancelableMove()')
    expect(onStartBody()).toContain('claimsGesture')
    expect(onStartBody()).toContain('window.scrollY <= 0')
    expect(onStartBody().indexOf('if (!eligible)')).toBeLessThan(
      onStartBody().indexOf('armCancelableMove()')
    )
    // The lifetime registration (next to touchstart) must not be the
    // non-passive one: that is the iOS document-pan killer.
    const setupStart = source.indexOf("window.addEventListener('touchstart', onStart, { passive: true })")
    expect(setupStart).toBeGreaterThan(-1)
    const setup = source.slice(setupStart, source.indexOf("window.addEventListener('touchend'", setupStart))
    expect(setup).toContain('{ passive: true }')
    expect(setup).not.toContain('{ passive: false }')
  })

  it('gates preventDefault on pull intent, not on raw travel', () => {
    expect(helper('onCancelableMove')).toContain(
      'if (shouldPreventPullMove(intent) && event.cancelable) event.preventDefault()'
    )
    expect(source).not.toContain('raw > PULL_CLAIM_PX && event.cancelable')
    expect(source).toContain('intent = pullIntent(raw, window.scrollY, intent, rawX)')
  })

  it('refuses a control the same way it refuses a field', () => {
    expect(source).toContain('ownsTouchAsControl(node)')
    expect(source).toContain("['BUTTON', 'A', 'SUMMARY', 'LABEL']")
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

  it('refuses a tap on an interactive control, even at the top of the list', () => {
    // Composer Send: a few pixels of noise on `.primary` used to be claimed
    // as a pull, preventDefault cancelled the click, the follow-up never left.
    expect(ownsTouchAsControl(plain({ tagName: 'BUTTON' }))).toBe(true)
    expect(ownsTouchAsControl(plain({ tagName: 'A' }))).toBe(true)
    expect(ownsTouchAsControl(plain({ tagName: 'SUMMARY' }))).toBe(true)
    expect(ownsTouchAsControl(plain({ tagName: 'LABEL' }))).toBe(true)
    expect(ownsTouchAsControl(plain({ tagName: 'DIV' }))).toBe(false)
    expect(ownsTouchAsField(plain({ tagName: 'BUTTON' }))).toBe(false)
    expect(claimsGesture([plain({ tagName: 'BUTTON' })])).toBe(false)
    expect(claimsGesture([plain({ tagName: 'A' })])).toBe(false)
    expect(claimsGesture([plain({ tagName: 'SUMMARY' })])).toBe(false)
    expect(claimsGesture([plain({ tagName: 'LABEL' })])).toBe(false)
    // The finger lands on the label text, not the <button> itself.
    expect(claimsGesture([plain({ tagName: 'SPAN' }), plain({ tagName: 'BUTTON' })])).toBe(false)
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
