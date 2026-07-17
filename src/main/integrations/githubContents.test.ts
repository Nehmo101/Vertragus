import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readGithubOAuthToken } from '@main/config/secrets'
import {
  ensureRetroBranch,
  getRepoFile,
  githubContentsInternals,
  putRepoFile,
  resolveGithubToken
} from './githubContents'

vi.mock('@main/config/secrets', () => ({
  readGithubOAuthToken: vi.fn(() => 'stored-token')
}))

interface FakeCall {
  url: string
  method: string
  body?: unknown
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as unknown as Response
}

const REF = { owner: 'Nehmo101', repo: 'Vertragus', branch: 'retros' }

describe('githubContents', () => {
  const calls: FakeCall[] = []
  let responses: Response[] = []

  beforeEach(() => {
    githubContentsInternals.reset()
    calls.length = 0
    responses = []
    vi.mocked(readGithubOAuthToken).mockReturnValue('stored-token')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
        calls.push({
          url: String(url),
          method: init?.method ?? 'GET',
          body: init?.body ? JSON.parse(init.body) : undefined
        })
        const next = responses.shift()
        if (!next) throw new Error(`Unerwarteter fetch-Aufruf: ${String(url)}`)
        return next
      })
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses the stored OAuth token for API calls', async () => {
    await expect(resolveGithubToken()).resolves.toBe('stored-token')
  })

  it('returns undefined for missing files and decodes existing ones', async () => {
    responses = [
      jsonResponse(404, { message: 'Not Found' }),
      jsonResponse(200, {
        content: Buffer.from('# Overlay', 'utf8').toString('base64'),
        sha: 'abc123',
        size: 9
      })
    ]
    await expect(getRepoFile(REF, 'overlay/learnings.md')).resolves.toBeUndefined()
    await expect(getRepoFile(REF, 'overlay/learnings.md')).resolves.toEqual({
      content: '# Overlay',
      sha: 'abc123',
      size: 9
    })
    expect(calls[0].url).toContain('/contents/overlay%2Flearnings.md'.replace('%2F', '/'))
    expect(calls[0].url).toContain('?ref=retros')
  })

  it('puts base64 content onto the retro branch', async () => {
    responses = [jsonResponse(201, {})]
    await putRepoFile({
      ref: REF,
      path: 'runs/2026/07/retro-1.json',
      content: '{"a":1}',
      message: 'Retro retro-1'
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('PUT')
    expect(calls[0].url).toContain('/repos/Nehmo101/Vertragus/contents/runs/2026/07/retro-1.json')
    expect(calls[0].body).toMatchObject({
      branch: 'retros',
      message: 'Retro retro-1',
      content: Buffer.from('{"a":1}', 'utf8').toString('base64')
    })
    expect(calls[0].body).not.toHaveProperty('sha')
  })

  it('retries a conflicting put once with the fetched sha', async () => {
    responses = [
      jsonResponse(422, { message: 'sha wasn’t supplied' }),
      jsonResponse(200, { content: Buffer.from('old').toString('base64'), sha: 'oldsha', size: 3 }),
      jsonResponse(200, {})
    ]
    await putRepoFile({
      ref: REF,
      path: 'runs/2026/07/retro-1.json',
      content: 'neu',
      message: 'Retro update'
    })
    expect(calls).toHaveLength(3)
    expect(calls[2].method).toBe('PUT')
    expect(calls[2].body).toMatchObject({ sha: 'oldsha' })
  })

  it('refuses writing to a protected branch', async () => {
    await expect(
      putRepoFile({ ref: { ...REF, branch: 'main' }, path: 'x', content: '', message: 'm' })
    ).rejects.toThrow(/geschützten Branch/)
    expect(calls).toHaveLength(0)
  })

  it('treats an existing branch as ensured without git-data calls', async () => {
    responses = [
      jsonResponse(200, { default_branch: 'DEV' }),
      jsonResponse(200, { name: 'retros' })
    ]
    await ensureRetroBranch(REF, 'README')
    expect(calls).toHaveLength(2)
    // Zweiter Aufruf im selben Prozess: gecacht, keine weiteren Requests.
    await ensureRetroBranch(REF, 'README')
    expect(calls).toHaveLength(2)
  })

  it('bootstraps a missing branch as an orphan commit', async () => {
    responses = [
      jsonResponse(200, { default_branch: 'DEV' }),
      jsonResponse(404, { message: 'Branch not found' }),
      jsonResponse(201, { sha: 'blob-sha' }),
      jsonResponse(201, { sha: 'tree-sha' }),
      jsonResponse(201, { sha: 'commit-sha' }),
      jsonResponse(201, {})
    ]
    await ensureRetroBranch(REF, '# Retros')
    expect(calls.map((call) => call.method)).toEqual(['GET', 'GET', 'POST', 'POST', 'POST', 'POST'])
    expect(calls[2].url).toContain('/git/blobs')
    expect(calls[3].url).toContain('/git/trees')
    expect(calls[4].url).toContain('/git/commits')
    expect(calls[4].body).toMatchObject({ parents: [], tree: 'tree-sha' })
    expect(calls[5].url).toContain('/git/refs')
    expect(calls[5].body).toMatchObject({ ref: 'refs/heads/retros', sha: 'commit-sha' })
  })

  it('refuses a retro branch equal to the repository default branch', async () => {
    responses = [jsonResponse(200, { default_branch: 'retros-data' })]
    await expect(
      ensureRetroBranch({ ...REF, branch: 'retros-data' }, 'README')
    ).rejects.toThrow(/geschützten Branch/)
  })
})
