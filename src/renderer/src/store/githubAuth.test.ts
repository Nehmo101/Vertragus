import { describe, expect, it } from 'vitest'
import type { GithubAuthStatus } from '@shared/ipc'
import { githubAuthPresentation, hasUsableGithubAuth } from './githubAuth'

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

// Negative controls for the OAuth surface consumed by ProfileEditor's GitHub
// connection panel (Browser-OAuth via VERTRAGUS_GITHUB_OAUTH_CLIENT_ID). These
// guard the three controls the security gate requires for the oauth surface:
// authorization, validation and secret-leak.
describe('GitHub OAuth session security controls', () => {
  it('denies GitHub actions for an OAuth session with an invalid scope grant (authorization)', () => {
    // Authenticated, but the OAuth grant is missing the required `repo` scope:
    // an insufficient/unauthorized session must never unlock repo actions.
    const insufficientScope = status({
      authenticated: true,
      method: 'oauth',
      account: 'eowyn',
      scopes: ['read:org'],
      missingScopes: ['repo'],
      needsReauth: true
    })
    expect(hasUsableGithubAuth(insufficientScope)).toBe(false)
    expect(githubAuthPresentation(insufficientScope).label).toBe('Erneuern')

    // A fully unauthenticated response is likewise denied — no access is granted.
    const unauthenticated = status({ authenticated: false })
    expect(hasUsableGithubAuth(unauthenticated)).toBe(false)
    expect(githubAuthPresentation(unauthenticated).label).toBe('Login')
  })

  it('rejects a malformed OAuth status that claims auth while flagged for reauth (validation)', () => {
    // Inconsistent/invalid backend payload: authenticated yet needsReauth. The
    // renderer must validate this as unusable instead of unlocking the account.
    const malformed = status({
      authenticated: true,
      method: 'oauth',
      account: 'eowyn',
      scopes: [],
      missingScopes: ['repo', 'workflow'],
      needsReauth: true
    })
    expect(hasUsableGithubAuth(malformed)).toBe(false)
    expect(githubAuthPresentation(malformed)).toEqual({
      label: 'Erneuern',
      detail: 'Berechtigungen fehlen: repo, workflow'
    })
  })

  it('never leaks token or account material through the reauth detail (secret-leak)', () => {
    // Even if the backend erroneously carries secret-shaped account material,
    // the reauth presentation is built only from scope names and must redact it.
    const leakSentinel = 'token-material-must-not-render'
    const auth = status({
      authenticated: true,
      method: 'oauth',
      account: leakSentinel,
      scopes: ['read:org'],
      missingScopes: ['repo'],
      needsReauth: true
    })
    const view = githubAuthPresentation(auth)
    expect(view.detail).not.toContain(leakSentinel)
    expect(view.detail).toBe('Berechtigungen fehlen: repo')

    // A stale unauthenticated payload must not surface a leaked secret either.
    const stale = status({ account: leakSentinel, detail: 'Nicht angemeldet.' })
    expect(githubAuthPresentation(stale).detail).not.toContain(leakSentinel)
  })
})
