import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readGithubOAuthToken } from '@main/config/secrets'
import { githubContentsInternals } from './githubContents'
import { ISSUE_BODY_MAX_CHARS, githubIssuesInternals, listOpenIssues } from './githubIssues'

vi.mock('@main/config/secrets', () => ({
  readGithubOAuthToken: vi.fn(() => 'stored-token')
}))

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as unknown as Response
}

function rawIssue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 7,
    title: 'Composer breaks on empty goal',
    body: 'Steps to reproduce…',
    state: 'open',
    labels: [{ name: 'bug' }, { name: 'ui' }],
    html_url: 'https://github.com/acme/demo/issues/7',
    user: { login: 'octocat' },
    updated_at: '2026-07-20T10:00:00Z',
    ...overrides
  }
}

describe('githubIssues', () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  let responses: Response[] = []

  beforeEach(() => {
    githubContentsInternals.reset()
    calls.length = 0
    responses = []
    vi.mocked(readGithubOAuthToken).mockReturnValue('stored-token')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
        calls.push({ url: String(url), headers: init?.headers ?? {} })
        const next = responses.shift()
        if (!next) throw new Error(`Unerwarteter fetch-Aufruf: ${String(url)}`)
        return next
      })
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('lists open issues with token auth and bounded page size', async () => {
    responses = [jsonResponse(200, [rawIssue()])]
    const result = await listOpenIssues({ owner: 'acme', repo: 'demo' })
    expect(result).toEqual({
      owner: 'acme',
      repo: 'demo',
      issues: [
        {
          number: 7,
          title: 'Composer breaks on empty goal',
          body: 'Steps to reproduce…',
          bodyTruncated: false,
          labels: ['bug', 'ui'],
          url: 'https://github.com/acme/demo/issues/7',
          author: 'octocat',
          updatedAt: '2026-07-20T10:00:00Z'
        }
      ]
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toContain('/repos/acme/demo/issues?state=open')
    expect(calls[0].url).toContain('per_page=30')
    expect(calls[0].headers.Authorization).toBe('Bearer stored-token')
  })

  it('filters pull requests out of the /issues rows', async () => {
    responses = [
      jsonResponse(200, [
        rawIssue({ number: 1 }),
        rawIssue({ number: 2, pull_request: { url: 'https://api.github.com/…' } }),
        rawIssue({ number: 3 })
      ])
    ]
    const result = await listOpenIssues({ owner: 'acme', repo: 'demo' })
    expect(result.issues.map((issue) => issue.number)).toEqual([1, 3])
  })

  it('truncates long bodies and flags the truncation', async () => {
    responses = [jsonResponse(200, [rawIssue({ body: 'x'.repeat(ISSUE_BODY_MAX_CHARS + 500) })])]
    const [issue] = (await listOpenIssues({ owner: 'acme', repo: 'demo' })).issues
    expect(issue.bodyTruncated).toBe(true)
    expect(issue.body.length).toBeLessThanOrEqual(ISSUE_BODY_MAX_CHARS + 1)
    expect(issue.body.endsWith('…')).toBe(true)
  })

  it('clamps the requested limit into 1–50', async () => {
    responses = [jsonResponse(200, []), jsonResponse(200, [])]
    await listOpenIssues({ owner: 'acme', repo: 'demo', limit: 500 })
    await listOpenIssues({ owner: 'acme', repo: 'demo', limit: 0 })
    expect(calls[0].url).toContain('per_page=50')
    expect(calls[1].url).toContain('per_page=1')
  })

  it('surfaces API errors with status and message', async () => {
    responses = [jsonResponse(404, { message: 'Not Found' })]
    await expect(listOpenIssues({ owner: 'acme', repo: 'demo' })).rejects.toThrow(
      /GitHub-API 404 bei Issues von acme\/demo — Not Found/
    )
  })

  it('rejects invalid owner/repo slugs before any request', async () => {
    await expect(listOpenIssues({ owner: '../evil', repo: 'demo' })).rejects.toThrow(/Ungültiger Owner/)
    await expect(listOpenIssues({ owner: 'acme', repo: 'a/b' })).rejects.toThrow(/Ungültiger Repository/)
    expect(calls).toHaveLength(0)
  })

  it('drops rows without number or title and tolerates string labels', () => {
    expect(githubIssuesInternals.mapIssue({ title: 'no number' })).toBeUndefined()
    expect(githubIssuesInternals.mapIssue({ number: 4, title: '  ' })).toBeUndefined()
    const mapped = githubIssuesInternals.mapIssue({
      number: 4,
      title: 'Labels as strings',
      labels: ['bug', '  ', { name: 'ui' }, {}]
    })
    expect(mapped?.labels).toEqual(['bug', 'ui'])
    expect(mapped?.body).toBe('')
    expect(mapped?.bodyTruncated).toBe(false)
  })
})
