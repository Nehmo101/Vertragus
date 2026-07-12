import { describe, expect, it } from 'vitest'
import { githubAuthInternals } from './githubAuth'

describe('githubAuth helpers', () => {
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

  it('builds reauth status when scopes are incomplete', () => {
    const status = githubAuthInternals.buildGithubAuthStatus({
      authenticated: true,
      method: 'gh-cli',
      account: 'nehmo',
      scopes: ['repo'],
      oauthConfigured: false
    })
    expect(status.needsReauth).toBe(true)
    expect(status.missingScopes).toContain('project')
  })
})
