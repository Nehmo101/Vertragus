import { describe, expect, it } from 'vitest'
import { githubIssueListRequestSchema } from './ipcSchemas'

describe('githubIssueListRequestSchema', () => {
  it('accepts owner/repo with an optional bounded limit', () => {
    expect(githubIssueListRequestSchema.parse({ owner: 'acme', repo: 'demo' })).toEqual({
      owner: 'acme',
      repo: 'demo'
    })
    expect(
      githubIssueListRequestSchema.parse({ owner: 'acme', repo: 'demo', limit: 50 })
    ).toEqual({ owner: 'acme', repo: 'demo', limit: 50 })
  })

  it('rejects missing or empty owner/repo', () => {
    expect(githubIssueListRequestSchema.safeParse({ repo: 'demo' }).success).toBe(false)
    expect(githubIssueListRequestSchema.safeParse({ owner: '', repo: 'demo' }).success).toBe(false)
    expect(githubIssueListRequestSchema.safeParse({ owner: 'acme', repo: '' }).success).toBe(false)
  })

  it('rejects out-of-range, fractional or non-numeric limits', () => {
    for (const limit of [0, 51, 1.5, '10', -1]) {
      expect(
        githubIssueListRequestSchema.safeParse({ owner: 'acme', repo: 'demo', limit }).success,
        String(limit)
      ).toBe(false)
    }
  })

  it('rejects non-object payloads', () => {
    expect(githubIssueListRequestSchema.safeParse('acme/demo').success).toBe(false)
    expect(githubIssueListRequestSchema.safeParse(undefined).success).toBe(false)
  })
})
