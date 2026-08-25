import { describe, expect, it, vi } from 'vitest'
import {
  OVERLAP_TAIL_CHARS,
  attachScroll,
  planAttach,
  trackWritten,
  type AttachPlan
} from './terminalAttach'

describe('planAttach', () => {
  it('writes the whole snapshot into a terminal that has nothing yet', () => {
    expect(planAttach({ snapshot: 'hello', written: '' })).toEqual({
      kind: 'append',
      data: 'hello'
    })
  })

  it('appends only what arrived while the phone was away', () => {
    expect(planAttach({ snapshot: 'abcdef', written: 'abcd' })).toEqual({
      kind: 'append',
      data: 'ef'
    })
  })

  it('writes nothing when the reconnect brought no new output', () => {
    expect(planAttach({ snapshot: 'abcd', written: 'abcd' })).toEqual({ kind: 'append', data: '' })
  })

  it('aligns on the tail even when the host trimmed its head', () => {
    // The client only ever keeps a tail, so a snapshot that starts later than
    // the session did still contains it.
    expect(planAttach({ snapshot: 'cdefgh', written: 'cdef' })).toEqual({
      kind: 'append',
      data: 'gh'
    })
  })

  it('takes the most recent occurrence of a tail that repeats', () => {
    // A prompt string can easily appear twice; our position is the last one.
    expect(planAttach({ snapshot: '$ x$ y', written: '$ ' })).toEqual({
      kind: 'append',
      data: 'y'
    })
  })

  it('rebuilds only when the streams genuinely diverged', () => {
    expect(planAttach({ snapshot: 'fresh session', written: 'old session' })).toEqual({
      kind: 'replay',
      data: 'fresh session'
    })
  })
})

/*
 * What the search costs, and why it is allowed to look everywhere.
 *
 * `planAttach` runs synchronously in the renderer of a phone that has just
 * woken up, on a snapshot that can be the host's whole 2 MB scrollback. The
 * host bounds its own version of this search with a window; this one is
 * bounded by what it may do to each character instead, which is what lets it
 * search the whole snapshot — and searching the whole snapshot is the point,
 * because a miss here does not cost bandwidth, it costs `reset()`.
 */
describe('the search planAttach makes', () => {
  /** A tail that matches everywhere but its last character. */
  const nearMiss = `${'A'.repeat(OVERLAP_TAIL_CHARS - 1)}B`

  it('reads each character of the snapshot exactly once', () => {
    // The property the speed comes from, counted rather than timed: a naive
    // backwards scan re-reads the same characters `written.length` times over.
    const text = 'A'.repeat(50_000)
    let reads = 0
    const counted = {
      length: text.length,
      charCodeAt: (index: number): number => {
        reads += 1
        return text.charCodeAt(index)
      }
    }
    // On the miss path `planAttach` reaches the snapshot only through `length`
    // and `charCodeAt`, so this stand-in is a faithful one; the cast is the
    // only way to say that to a signature that rightly asks for the string the
    // terminal is going to be written with.
    const plan = planAttach({
      snapshot: counted as unknown as string,
      written: `${'A'.repeat(999)}B`
    })
    expect(plan.kind).toBe('replay')
    expect(reads).toBe(text.length)
  })

  it('keeps the place of a reader further back than the host would search', () => {
    // The correlated case, and the reason there is no window on this side: the
    // bridge sends the whole scrollback precisely when it could not place this
    // client's marker, and the commonest reason it could not is that the client
    // sits further back than the region it searches. The tail is still in the
    // frame — 300 KB from its end — so this is an append and the reader does
    // not move. A window here would have made it a reset.
    const written = trackWritten('', nearMiss)
    const snapshot = `${'A'.repeat(1_691_808)}${written}${'A'.repeat(300_000)}`
    expect(snapshot.length).toBe(2_000_000)
    const plan = planAttach({ snapshot, written })
    // Lengths rather than the strings: a failure here should name the delta,
    // not print two megabytes of it.
    expect(plan.kind).toBe('append')
    expect(plan.data.length).toBe(300_000)
    expect(attachScroll(plan, false)).toBe('hold')
  })

  it('answers a full scrollback it cannot place in milliseconds', () => {
    // The measured case, kept as an executable record: a 2,000,000-character
    // scrollback of one repeated character against the 8 KB tail. Measured on
    // this project's own limits: ~45 ms as it stands, ~7,600 ms under
    // `String.prototype.lastIndexOf`. The threshold is a cost CLASS, an order
    // of magnitude clear of both sides, because the two assertions above would
    // not notice a regression to the naive scan on the real `string` path.
    // Windows quality CI has landed ~570 ms under a loaded vitest run — still
    // far from the naive scan — so the ceiling sits at 2 s, not 500 ms.
    // Self-check for the clock this reads: a faked one reports that everything
    // took zero, which would make the assertion below pass whatever
    // `planAttach` did. Nothing in this file fakes timers today, and this is
    // what says so if that ever changes.
    expect(vi.isFakeTimers()).toBe(false)

    const started = performance.now()
    const plan = planAttach({ snapshot: 'A'.repeat(2_000_000), written: nearMiss })
    const elapsed = performance.now() - started
    expect(plan.kind).toBe('replay')
    expect(elapsed).toBeLessThan(2_000)
  })
})

describe('attachScroll', () => {
  const append: AttachPlan = { kind: 'append', data: 'x' }
  const replay: AttachPlan = { kind: 'replay', data: 'x' }

  it('leaves a paused reader exactly where they were', () => {
    expect(attachScroll(append, false)).toBe('hold')
  })

  it('follows the newest line for a reader who was following', () => {
    expect(attachScroll(append, true)).toBe('bottom')
  })

  it('lands at the newest line after a rebuild, paused or not', () => {
    expect(attachScroll(replay, false)).toBe('bottom')
    expect(attachScroll(replay, true)).toBe('bottom')
  })
})

describe('trackWritten', () => {
  it('accumulates what was written', () => {
    expect(trackWritten('ab', 'cd')).toBe('abcd')
  })

  it('keeps only the tail once past the limit', () => {
    expect(trackWritten('abcd', 'ef', 3)).toBe('def')
  })

  it('trims an oversized tail even when nothing new arrives', () => {
    expect(trackWritten('abcdef', '', 2)).toBe('ef')
  })

  it('holds nothing at all for a limit of zero', () => {
    expect(trackWritten('abc', 'de', 0)).toBe('')
  })

  it('defaults to a tail long enough that a chance repeat is not a risk', () => {
    expect(OVERLAP_TAIL_CHARS).toBeGreaterThanOrEqual(4096)
    expect(trackWritten('', 'x'.repeat(OVERLAP_TAIL_CHARS + 5)).length).toBe(OVERLAP_TAIL_CHARS)
  })
})

describe('a reconnect while the reader is paused', () => {
  it('adds the new output and does not move the viewport', () => {
    // The exact sequence a locked phone produces: attach, stream, reconnect.
    let written = trackWritten('', 'line 1\nline 2\n')
    written = trackWritten(written, 'line 3\n')
    const plan = planAttach({ snapshot: 'line 1\nline 2\nline 3\nline 4\n', written })
    expect(plan).toEqual({ kind: 'append', data: 'line 4\n' })
    expect(attachScroll(plan, false)).toBe('hold')
  })
})
