import type { GithubAuthStatus } from '@shared/ipc'

export type GithubAuthPresentation = {
  label: 'Prüfe…' | 'Verbunden' | 'Erneuern' | 'Login'
  detail: string
}

type UsableGithubAuthStatus = GithubAuthStatus & { authenticated: true; needsReauth: false }

/** A session with missing repository scopes must not unlock GitHub actions. */
export function hasUsableGithubAuth(status: GithubAuthStatus | null): status is UsableGithubAuthStatus {
  return Boolean(status?.authenticated && !status.needsReauth)
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

  if (status.authenticated) {
    return {
      label: 'Erneuern',
      detail: `Berechtigungen fehlen: ${status.missingScopes.join(', ') || 'unbekannt'}`
    }
  }

  return { label: 'Login', detail: status.detail ?? 'Nicht angemeldet' }
}
