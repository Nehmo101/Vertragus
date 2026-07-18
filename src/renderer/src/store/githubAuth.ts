import type { GithubAuthMethod, GithubAuthStatus } from '@shared/ipc'

export type GithubAuthPresentation = {
  label: 'Prüfe…' | 'Verbunden' | 'Erneuern' | 'Login'
  detail: string
}

type UsableGithubAuthStatus = GithubAuthStatus & { authenticated: true; needsReauth: false }

const GITHUB_AUTH_METHODS: readonly GithubAuthMethod[] = ['none', 'gh-cli', 'oauth']

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

/**
 * The GitHub auth/OAuth status is produced in the main process and reaches the
 * renderer across the IPC bridge, so its shape is untrusted here. Reject a
 * malformed OAuth response before any surface treats it as a real session —
 * a bogus `authenticated`/`scopes` payload must never unlock GitHub actions.
 */
export function isValidGithubAuthStatus(status: GithubAuthStatus | null | undefined): status is GithubAuthStatus {
  return Boolean(
    status &&
      typeof status === 'object' &&
      typeof status.authenticated === 'boolean' &&
      typeof status.needsReauth === 'boolean' &&
      typeof status.oauthConfigured === 'boolean' &&
      GITHUB_AUTH_METHODS.includes(status.method) &&
      isStringArray(status.scopes) &&
      isStringArray(status.missingScopes)
  )
}

/** Assert form of the GitHub OAuth status; throws on an invalid/malformed payload. */
export function assertValidGithubAuthStatus(status: GithubAuthStatus): GithubAuthStatus {
  if (!isValidGithubAuthStatus(status)) {
    throw new Error('Ungültige GitHub-OAuth-Antwort.')
  }
  return status
}

/** A session with missing repository scopes must not unlock GitHub actions. */
export function hasUsableGithubAuth(status: GithubAuthStatus | null): status is UsableGithubAuthStatus {
  return isValidGithubAuthStatus(status) && Boolean(status.authenticated && !status.needsReauth)
}

/**
 * Keep every renderer surface on the status returned by github:authStatus.
 * In particular, never render an account returned alongside an unauthenticated
 * response; that could be stale data from a previous session.
 */
export function githubAuthPresentation(status: GithubAuthStatus | null): GithubAuthPresentation {
  if (!status) return { label: 'Prüfe…', detail: 'GitHub-Status wird geprüft' }

  if (hasUsableGithubAuth(status)) {
    return {
      label: 'Verbunden',
      detail: status.detail ?? `Angemeldet als ${status.account ?? 'GitHub'}`
    }
  }

  if (status.needsReauth) {
    return {
      label: 'Erneuern',
      detail: `Berechtigungen fehlen: ${status.missingScopes.join(', ') || 'unbekannt'}`
    }
  }

  return { label: 'Login', detail: status.detail ?? 'Nicht angemeldet' }
}
