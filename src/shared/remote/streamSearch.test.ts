import { describe, expect, it } from 'vitest'
import { lastIndexOfFrom } from './streamSearch'

/*
 * The cost of the search, pinned as a property rather than as a stopwatch.
 *
 * This function runs synchronously at both ends of the remote protocol, on
 * operands the other end chose the size and content of: in the Electron main
 * process on an `attach` frame, and in the phone's renderer on a `snapshot`
 * frame. With a naive scan that is a multi-second freeze of everything sharing
 * the thread. A wall-clock assertion would only say that this machine was fast
 * today, so what is asserted instead is the property the speed comes from: how
 * many times the search may touch each character it looks at.
 */
describe('lastIndexOfFrom reads what it searches once', () => {
  it('reads each character of the region it searches exactly once', () => {
    // KMP never moves backwards through the haystack, and `IndexedChars` is
    // what lets that be counted instead of timed.
    const text = 'A'.repeat(50_000)
    let reads = 0
    const counted = {
      length: text.length,
      charCodeAt: (index: number): number => {
        reads += 1
        return text.charCodeAt(index)
      }
    }
    const from = 10_000
    // A needle that matches everywhere but the last character — the shape that
    // makes a naive scan quadratic.
    expect(lastIndexOfFrom(counted, `${'A'.repeat(999)}B`, from)).toBe(-1)
    expect(reads).toBe(text.length - from)
  })
})

describe('lastIndexOfFrom agrees with the search it replaces', () => {
  it('matches String.lastIndexOf across randomised inputs', () => {
    // A hand-rolled string search is a correctness risk in the main process,
    // and the reference implementation is right there: for every input where
    // both are allowed to look at the whole haystack, they must agree. The
    // alphabet is deliberately tiny, so partial matches, overlaps and repeats
    // are the common case rather than the exotic one.
    let checked = 0
    let matched = 0
    for (let seed = 1; seed <= 400; seed += 1) {
      // A cheap deterministic PRNG — a fixed sequence, so a failure reproduces.
      let state = seed * 2654435761
      const next = (bound: number): number => {
        state = (state * 1103515245 + 12345) & 0x7fffffff
        return state % bound
      }
      const draw = (length: number): string =>
        Array.from({ length }, () => 'ab\n'[next(3)]).join('')
      const haystack = draw(next(60) + 1)
      const needle = draw(next(5) + 1)
      const expected = haystack.lastIndexOf(needle)
      expect(lastIndexOfFrom(haystack, needle, 0)).toBe(expected)
      checked += 1
      if (expected >= 0) matched += 1
    }
    // Self-check: a generator that never produced a match would have proven
    // only that both agree on -1.
    expect(checked).toBe(400)
    expect(matched).toBeGreaterThan(100)
  })

  it('never reports a match that begins before `from`', () => {
    expect(lastIndexOfFrom('abcabc', 'abc', 0)).toBe(3)
    expect(lastIndexOfFrom('abcabc', 'abc', 3)).toBe(3)
    expect(lastIndexOfFrom('abcabc', 'abc', 4)).toBe(-1)
    // A match straddling the boundary does not count: the region is the region.
    expect(lastIndexOfFrom('xxabcxx', 'abc', 3)).toBe(-1)
  })

  it('refuses an empty needle and a needle longer than what is left', () => {
    expect(lastIndexOfFrom('abc', '', 0)).toBe(-1)
    expect(lastIndexOfFrom('abc', 'abcd', 0)).toBe(-1)
    expect(lastIndexOfFrom('abc', 'bc', 2)).toBe(-1)
  })
})
