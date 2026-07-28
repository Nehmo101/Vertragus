/**
 * Read-only GitHub Issues listing for the "GitHub-Issue als Ziel" flow
 * (Open-Core Zug 4.1). Uses the same authenticated REST transport as the
 * retro sync client (githubContents.ts): stored OAuth token or gh CLI token,
 * bearer-authenticated fetch with a bounded timeout.
 */
import type { GithubIssueListRequest, GithubIssueListResult, GithubIssueSummary } from '@shared/ipc'
import { resolveGithubToken } from '@main/integrations/githubContents'

const API_BASE = 'https://api.github.com'
const REQUEST_TIMEOUT_MS = 15_000
const DEFAULT_LIMIT = 30
const MAX_LIMIT = 50

/** Issue bodies are trimmed to a composer-friendly length. */
export const ISSUE_BODY_MAX_CHARS = 2000

interface RawGithubIssue {
  number?: number
  title?: string
  body?: string | null
  state?: string
  labels?: Array<string | { name?: string }>
  html_url?: string
  user?: { login?: string }
  updated_at?: string
  /** Present exactly when the row is a pull request, not an issue. */
  pull_request?: unknown
}

function normalizeRepoSlug(value: string, label: string): string {
  const normalized = value.trim()
  if (!/^[A-Za-z0-9._-]+$/.test(normalized)) {
    throw new Error(`Ungültiger ${label}: ${value}`)
  }
  return normalized
}

function truncateBody(body: string | null | undefined): { body: string; truncated: boolean } {
  const value = (body ?? '').replace(/\r\n/g, '\n').trim()
  if (value.length <= ISSUE_BODY_MAX_CHARS) return { body: value, truncated: false }
  return { body: `${value.slice(0, ISSUE_BODY_MAX_CHARS).trimEnd()}…`, truncated: true }
}

function mapIssue(row: RawGithubIssue): GithubIssueSummary | undefined {
  // The /issues endpoint also returns pull requests — those rows carry a
  // `pull_request` key and are excluded here.
  if (row.pull_request !== undefined) return undefined
  const number = row.number
  const title = row.title?.trim()
  if (!Number.isInteger(number) || !title) return undefined
  const { body, truncated } = truncateBody(row.body)
  const labels = (row.labels ?? [])
    .map((label) => (typeof label === 'string' ? label : label?.name ?? ''))
    .map((name) => name.trim())
    .filter(Boolean)
  return {
    number: number as number,
    title,
    body,
    bodyTruncated: truncated,
    labels,
    url: row.html_url?.trim() || '',
    author: row.user?.login?.trim() || undefined,
    updatedAt: row.updated_at?.trim() || ''
  }
}

async function apiError(action: string, response: Response): Promise<Error> {
  let detail = ''
  try {
    const body = (await response.json()) as { message?: string }
    if (body?.message) detail = ` — ${body.message}`
  } catch {
    // Fehlerdetails sind optional.
  }
  return new Error(`GitHub-API ${response.status} bei ${action}${detail}`)
}

export async function listOpenIssues(req: GithubIssueListRequest): Promise<GithubIssueListResult> {
  const owner = normalizeRepoSlug(req.owner, 'Owner')
  const repo = normalizeRepoSlug(req.repo, 'Repository')
  const limit = Math.min(Math.max(Math.trunc(req.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT)

  const token = await resolveGithubToken()
  const response = await fetch(
    `${API_BASE}/repos/${owner}/${repo}/issues?state=open&sort=updated&direction=desc&per_page=${limit}`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28'
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    }
  )
  if (!response.ok) throw await apiError(`Issues von ${owner}/${repo}`, response)

  const rows = (await response.json()) as RawGithubIssue[]
  const issues = (Array.isArray(rows) ? rows : [])
    .map((row) => mapIssue(row))
    .filter((row): row is GithubIssueSummary => Boolean(row))
    .slice(0, limit)
  return { owner, repo, issues }
}

/** Nur für Tests: interne Helfer. */
export const githubIssuesInternals = {
  normalizeRepoSlug,
  truncateBody,
  mapIssue
}
