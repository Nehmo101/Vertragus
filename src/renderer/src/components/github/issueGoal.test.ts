import { describe, expect, it } from 'vitest'
import type { GithubIssueSummary } from '@shared/ipc'
import { filterIssues, formatIssueGoal, relativeUpdatedParts } from './issueGoal'

function issue(overrides: Partial<GithubIssueSummary> = {}): GithubIssueSummary {
  return {
    number: 42,
    title: 'Composer loses focus',
    body: 'After sending, focus jumps to the sidebar.',
    bodyTruncated: false,
    labels: ['bug', 'ui'],
    url: 'https://github.com/acme/demo/issues/42',
    author: 'octocat',
    updatedAt: '2026-07-20T10:00:00Z',
    ...overrides
  }
}

describe('formatIssueGoal', () => {
  it('produces the structured goal text with body and source', () => {
    expect(formatIssueGoal(issue())).toBe(
      'GitHub Issue #42: Composer loses focus\n\n' +
        'After sending, focus jumps to the sidebar.\n\n' +
        'Quelle: https://github.com/acme/demo/issues/42'
    )
  })

  it('skips empty body and url segments', () => {
    expect(formatIssueGoal(issue({ body: '', url: '' }))).toBe('GitHub Issue #42: Composer loses focus')
  })
})

describe('filterIssues', () => {
  const list = [
    issue({ number: 1, title: 'Crash on startup', labels: ['bug'] }),
    issue({ number: 2, title: 'Add dark theme', labels: ['enhancement'] }),
    issue({ number: 30, title: 'Docs typo', labels: [] })
  ]

  it('returns everything for an empty query', () => {
    expect(filterIssues(list, '  ')).toHaveLength(3)
  })

  it('matches title case-insensitively', () => {
    expect(filterIssues(list, 'DARK').map((i) => i.number)).toEqual([2])
  })

  it('matches labels', () => {
    expect(filterIssues(list, 'enhance').map((i) => i.number)).toEqual([2])
  })

  it('matches exact issue numbers with or without leading #', () => {
    expect(filterIssues(list, '#30').map((i) => i.number)).toEqual([30])
    expect(filterIssues(list, '30').map((i) => i.number)).toEqual([30])
    // "3" is not issue 30 — number matching is exact, not substring.
    expect(filterIssues(list, '3')).toHaveLength(0)
  })
})

describe('relativeUpdatedParts', () => {
  const now = Date.parse('2026-07-28T12:00:00Z')

  it.each([
    ['2026-07-28T11:59:40Z', { key: 'justNow' }],
    ['2026-07-28T11:30:00Z', { key: 'minutesAgo', count: 30 }],
    ['2026-07-28T07:00:00Z', { key: 'hoursAgo', count: 5 }],
    ['2026-07-25T12:00:00Z', { key: 'daysAgo', count: 3 }],
    ['2026-05-01T12:00:00Z', { key: 'monthsAgo', count: 2 }],
    ['2024-07-01T12:00:00Z', { key: 'yearsAgo', count: 2 }]
  ])('buckets %s', (iso, expected) => {
    expect(relativeUpdatedParts(iso, now)).toEqual(expected)
  })

  it('collapses invalid and future timestamps to justNow', () => {
    expect(relativeUpdatedParts('not-a-date', now)).toEqual({ key: 'justNow' })
    expect(relativeUpdatedParts('2027-01-01T00:00:00Z', now)).toEqual({ key: 'justNow' })
  })
})
