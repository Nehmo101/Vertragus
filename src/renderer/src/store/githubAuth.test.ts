import { describe, expect, it } from 'vitest'
import type { GithubAuthStatus } from '@shared/ipc'
import {
  assertValidGithubAuthStatus,
  githubAuthPresentation,
  hasUsableGithubAuth,
  isValidGithubAuthStatus
} from './githubAuth'

function status(overrides: Partial<GithubAuthStatus> = {}): GithubAuthStatus {
  return {
    authenticated: false,
    method: 'none',
    scopes: [],
    missingScopes: ['repo'],
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
      scopes: ['repo', 'read:org', 'read:project', 'workflow'],
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
      scopes: ['read:org'],
      missingScopes: ['repo'],
      needsReauth: true
    })

    expect(hasUsableGithubAuth(auth)).toBe(false)
    expect(githubAuthPresentation(auth)).toEqual({
      label: 'Erneuern',
      detail: 'Berechtigungen fehlen: repo'
    })
  })

  it('prioritizes reauth over an inconsistent unauthenticated flag', () => {
    const auth = status({
      authenticated: false,
      scopes: [],
      missingScopes: ['repo'],
      needsReauth: true
    })

    expect(githubAuthPresentation(auth).label).toBe('Erneuern')
  })
})

describe('GitHub OAuth status validation', () => {
  it('accepts a well-formed OAuth status', () => {
    const auth = status({ authenticated: true, method: 'oauth', scopes: ['repo'], missingScopes: [] })

    expect(isValidGithubAuthStatus(auth)).toBe(true)
    expect(assertValidGithubAuthStatus(auth)).toBe(auth)
  })

  it('rejects a null or non-object payload', () => {
    expect(isValidGithubAuthStatus(null)).toBe(false)
    expect(isValidGithubAuthStatus(undefined)).toBe(false)
    expect(isValidGithubAuthStatus('oauth' as unknown as GithubAuthStatus)).toBe(false)
  })

  it('rejects a malformed OAuth response and never treats it as usable', () => {
    const invalidMethod = { ...status({ authenticated: true }), method: 'saml' } as unknown as GithubAuthStatus
    const invalidScopes = { ...status({ authenticated: true }), scopes: 'repo' } as unknown as GithubAuthStatus
    const invalidFlag = { ...status({ authenticated: true }), needsReauth: 'no' } as unknown as GithubAuthStatus

    for (const bad of [invalidMethod, invalidScopes, invalidFlag]) {
      expect(isValidGithubAuthStatus(bad)).toBe(false)
      expect(() => assertValidGithubAuthStatus(bad)).toThrow(/Ungültige GitHub-OAuth-Antwort/)
      // A bogus payload must not unlock GitHub actions.
      expect(hasUsableGithubAuth(bad)).toBe(false)
    }
  })
})
