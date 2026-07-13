import { afterEach, describe, expect, it, vi } from 'vitest'
import { githubAuthInternals } from './githubAuth'

describe('githubAuth helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('parses gh auth status with scopes', () => {
    const parsed = githubAuthInternals.parseGhAuthStatus(`
github.com
  ✓ Logged in to github.com account nehmo (keyring)
  - Active account: true
  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'
`)
    expect(parsed.authenticated).toBe(true)
    expect(parsed.account).toBe('nehmo')
    expect(parsed.scopes).toEqual(['gist', 'read:org', 'repo', 'workflow'])
  })

  it('detects missing required scopes', () => {
    expect(githubAuthInternals.missingGithubScopes(['repo', 'gist'])).toEqual([
      'read:org',
      'project',
      'workflow'
    ])
  })

  it('keeps verified credentials visible while requiring missing scopes', () => {
    const status = githubAuthInternals.buildGithubAuthStatus({
      authenticated: true,
      method: 'gh-cli',
      account: 'nehmo',
      scopes: ['repo'],
      oauthConfigured: false
    })
    expect(status.authenticated).toBe(true)
    expect(status.method).toBe('gh-cli')
    expect(status.account).toBe('nehmo')
    expect(status.needsReauth).toBe(true)
    expect(status.missingScopes).toContain('project')
  })

  it.each([
    {
      name: 'empty token',
      token: '   ',
      response: undefined
    },
    {
      name: 'expired token',
      token: 'expired-token',
      response: { ok: false, status: 401 }
    },
    {
      name: 'missing account',
      token: 'valid-token',
      response: {
        ok: true,
        headers: new Headers({ 'x-oauth-scopes': 'repo, read:org, project, workflow' }),
        json: async () => ({})
      }
    }
  ])('rejects $name OAuth data before it can be shown as authenticated', async ({ token, response }) => {
    if (response) vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))

    await expect(githubAuthInternals.probeOAuthUser(token)).rejects.toThrow()
  })

  it('reports a verified OAuth account with missing scopes as needing reauth', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'x-oauth-scopes': 'repo, read:org, workflow' }),
      json: async () => ({ login: 'nehmo' })
    }))

    const user = await githubAuthInternals.probeOAuthUser('valid-token')
    const status = githubAuthInternals.buildGithubAuthStatus({
      authenticated: true,
      method: 'oauth',
      account: user.login,
      scopes: user.scopes
    })
    expect(status).toMatchObject({
      authenticated: true,
      method: 'oauth',
      account: 'nehmo',
      needsReauth: true,
      missingScopes: ['project']
    })
  })
})
