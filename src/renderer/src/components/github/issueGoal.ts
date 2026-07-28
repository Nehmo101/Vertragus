/**
 * Pure helpers for the GitHub issue picker: goal-text formatting, the
 * client-side list filter and relative-date bucketing. Kept free of React so
 * they are unit-testable in the node test environment.
 */
import type { GithubIssueSummary } from '@shared/ipc'

/**
 * Structured goal text inserted into the canvas composer. The user edits and
 * sends it themselves — this never triggers a send.
 */
export function formatIssueGoal(issue: GithubIssueSummary): string {
  const parts = [`GitHub Issue #${issue.number}: ${issue.title}`]
  if (issue.body) parts.push(issue.body)
  if (issue.url) parts.push(`Quelle: ${issue.url}`)
  return parts.join('\n\n')
}

/** Case-insensitive client-side filter over number, title and labels. */
export function filterIssues(issues: GithubIssueSummary[], query: string): GithubIssueSummary[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return issues
  const numeric = needle.replace(/^#/, '')
  return issues.filter(
    (issue) =>
      String(issue.number) === numeric ||
      issue.title.toLowerCase().includes(needle) ||
      issue.labels.some((label) => label.toLowerCase().includes(needle))
  )
}

export interface RelativeUpdatedParts {
  key: 'justNow' | 'minutesAgo' | 'hoursAgo' | 'daysAgo' | 'monthsAgo' | 'yearsAgo'
  count?: number
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const MONTH = 30 * DAY
const YEAR = 365 * DAY

/**
 * Buckets an ISO timestamp into an i18n-friendly relative description
 * (`issues.updated.<key>` with an optional count). Invalid or future
 * timestamps collapse to "just now".
 */
export function relativeUpdatedParts(iso: string, now = Date.now()): RelativeUpdatedParts {
  const then = Date.parse(iso)
  const diff = Number.isFinite(then) ? now - then : 0
  if (diff < MINUTE) return { key: 'justNow' }
  if (diff < HOUR) return { key: 'minutesAgo', count: Math.floor(diff / MINUTE) }
  if (diff < DAY) return { key: 'hoursAgo', count: Math.floor(diff / HOUR) }
  if (diff < MONTH) return { key: 'daysAgo', count: Math.floor(diff / DAY) }
  if (diff < YEAR) return { key: 'monthsAgo', count: Math.floor(diff / MONTH) }
  return { key: 'yearsAgo', count: Math.floor(diff / YEAR) }
}
