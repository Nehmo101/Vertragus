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
    expect(
      githubAuthInternals.buildGithubAuthStatus({
        ...parsed,
        method: 'gh-cli',
        oauthConfigured: false
      }).needsReauth
    ).toBe(false)
  })

  it('detects missing required scopes', () => {
    expect(githubAuthInternals.missingGithubScopes(['gist'])).toEqual(['repo'])
    expect(githubAuthInternals.missingGithubScopes(['repo', 'gist'])).toEqual([])
  })

  it('accepts a verified repository credential as a connected account', () => {
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
    expect(status.needsReauth).toBe(false)
    expect(status.missingScopes).toEqual([])
  })

  it('requires reauthentication when repository access is missing', () => {
    const status = githubAuthInternals.buildGithubAuthStatus({
      authenticated: true,
      method: 'gh-cli',
      account: 'nehmo',
      scopes: ['read:org', 'workflow'],
      oauthConfigured: false
    })
    expect(status.needsReauth).toBe(true)
    expect(status.missingScopes).toEqual(['repo'])
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

  it('keeps a verified OAuth account connected when only a feature scope is absent', async () => {
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
      needsReauth: false,
      missingScopes: []
    })
  })
})
