import { describe, expect, it } from 'vitest'
import type { GithubAuthStatus } from '@shared/ipc'
import { githubAuthPresentation, hasUsableGithubAuth } from './githubAuth'

function status(overrides: Partial<GithubAuthStatus> = {}): GithubAuthStatus {
  return {
    authenticated: false,
    method: 'none',
    scopes: [],
    missingScopes: ['repo', 'read:org', 'project', 'workflow'],
    needsReauth: false,
    oauthConfigured: false,
    ...overrides
  }
}

describe('GitHub auth presentation', () => {
  it('shows an authenticated account as connected', () => {
    const auth = status({
      authenticated: true,
      method: 'oauth',
      account: 'eowyn',
      scopes: ['repo', 'read:org', 'project', 'workflow'],
      missingScopes: [],
      detail: 'Angemeldet als eowyn (OAuth)'
    })

    expect(hasUsableGithubAuth(auth)).toBe(true)
    expect(githubAuthPresentation(auth)).toEqual({
      label: 'Verbunden',
      detail: 'Angemeldet als eowyn (OAuth)'
    })
  })

  it('keeps an unauthenticated response logged out even if it carries stale account data', () => {
    const auth = status({ account: 'former-account', detail: 'Nicht angemeldet.' })

    expect(hasUsableGithubAuth(auth)).toBe(false)
    expect(githubAuthPresentation(auth)).toEqual({ label: 'Login', detail: 'Nicht angemeldet.' })
    expect(githubAuthPresentation(auth).detail).not.toContain('former-account')
  })

  it('requires reauthentication when required scopes are missing', () => {
    const auth = status({
      authenticated: true,
      method: 'gh-cli',
      account: 'eowyn',
      scopes: ['repo'],
      missingScopes: ['read:org', 'project', 'workflow'],
      needsReauth: true
    })

    expect(hasUsableGithubAuth(auth)).toBe(false)
    expect(githubAuthPresentation(auth)).toEqual({
      label: 'Erneuern',
      detail: 'Berechtigungen fehlen: read:org, project, workflow'
    })
  })
})
