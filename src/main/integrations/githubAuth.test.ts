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

  it('never marks incomplete GitHub auth data as authenticated', () => {
    const status = githubAuthInternals.buildGithubAuthStatus({
      authenticated: true,
      method: 'gh-cli',
      account: 'nehmo',
      scopes: ['repo'],
      oauthConfigured: false
    })
    expect(status.authenticated).toBe(false)
    expect(status.method).toBe('none')
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
    },
    {
      name: 'missing required scope',
      token: 'valid-token',
      response: {
        ok: true,
        headers: new Headers({ 'x-oauth-scopes': 'repo, read:org, workflow' }),
        json: async () => ({ login: 'nehmo' })
      }
    }
  ])('rejects $name OAuth data before it can be shown as authenticated', async ({ token, response }) => {
    if (response) vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))

    await expect(githubAuthInternals.probeOAuthUser(token)).rejects.toThrow()
  })
})
