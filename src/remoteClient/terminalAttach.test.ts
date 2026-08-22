import { describe, expect, it } from 'vitest'
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
