import { describe, expect, it } from 'vitest'
import { limitReviewDiff, REVIEW_DIFF_LIMIT, reviewArgs } from './reviewDiff'

describe('task review diff', () => {
  it('uses a committed patch when a safe commit hash exists', () => {
    expect(reviewArgs({ commit: 'abcdef1234567' })).toEqual([
      'show',
      '--format=fuller',
      '--stat',
      '--patch',
      '--no-ext-diff',
      '--no-color',
      'abcdef1234567',
      '--'
    ])
  })

  it('falls back to the current worktree diff for invalid or missing hashes', () => {
    expect(reviewArgs({ commit: '../HEAD' })[0]).toBe('diff')
    expect(reviewArgs({})[0]).toBe('diff')
  })

  it('bounds renderer payloads', () => {
    expect(limitReviewDiff('small')).toEqual({ diff: 'small', truncated: false })
    const limited = limitReviewDiff('x'.repeat(REVIEW_DIFF_LIMIT + 10))
    expect(limited.truncated).toBe(true)
    expect(limited.diff.length).toBeLessThan(REVIEW_DIFF_LIMIT + 100)
  })
})
