/**
 * Pure profile repository readiness checks for inbox → workspace transfer.
 */
import type { ProfileCloneStatus, WorkspaceProfile } from '@shared/profile'
import { profileRepoLocalPath } from '@shared/profile'
import type { IdeaTransferAction } from '@shared/inboxTransfer'
import { assessProfileOrchestrator } from '@shared/inboxTransfer'
import type { GithubAuthStatus } from '@shared/ipc'

export { assessProfileOrchestrator }

export interface RepoReadinessReady {
  ready: true
  localPath: string
}

export interface RepoReadinessBlocked {
  ready: false
  action: IdeaTransferAction
  message: string
  retryable: boolean
  cloneStatus?: ProfileCloneStatus
  owner?: string
  repo?: string
  localPath?: string
}

export type RepoReadiness = RepoReadinessReady | RepoReadinessBlocked

/** True when GitHub auth is missing or scopes are incomplete for clone/API flows. */
export function githubNeedsAuth(status: GithubAuthStatus): boolean {
  return !status.authenticated || status.needsReauth
}

/** Map clone/bind/git errors to a transfer action when auth is the root cause. */
export function mapGithubErrorToTransferAction(error: unknown): IdeaTransferAction | undefined {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase()
  if (
    msg.includes('anmeldung') ||
    msg.includes('authentication') ||
    msg.includes('auth') ||
    msg.includes('could not read username') ||
    msg.includes('permission denied') ||
    msg.includes('bad credentials') ||
    msg.includes('support for password authentication was removed') ||
    msg.includes('401') ||
    msg.includes('403') ||
    msg.includes('denied') ||
    msg.includes('scope')
  ) {
    return 'needsAuth'
  }
  return undefined
}

export function buildNeedsAuthReadiness(detail?: string): RepoReadinessBlocked {
  return {
    ready: false,
    action: 'needsAuth',
    message:
      detail?.trim() ||
      'GitHub-Anmeldung fehlt oder Scopes sind unvollständig — bitte zuerst verbinden.',
    retryable: true
  }
}

/** Assess whether the profile has a usable local checkout for workspace spawn. */
export function assessRepoReadiness(
  profile: WorkspaceProfile,
  cloneStatus?: ProfileCloneStatus
): RepoReadiness {
  const binding = profile.githubRepo
  const localPath = profileRepoLocalPath(profile)

  if (!binding && !localPath) {
    return {
      ready: false,
      action: 'needsRepo',
      message: 'Kein Repository oder Arbeitsverzeichnis im Profil konfiguriert.',
      retryable: true
    }
  }

  if (binding) {
    const status = cloneStatus ?? binding.cloneStatus
    if (status === 'unbound' || status === 'linked') {
      return {
        ready: false,
        action: 'needsClone',
        message:
          status === 'linked'
            ? 'Zielverzeichnis ist bereit — Repository muss noch geklont werden.'
            : 'GitHub-Repository gebunden, aber kein lokaler Klon vorhanden.',
        retryable: true,
        cloneStatus: status,
        owner: binding.owner,
        repo: binding.repo,
        localPath: binding.localPath || localPath
      }
    }
    if (status === 'diverged') {
      return {
        ready: false,
        action: 'needsRepo',
        message: `origin weicht von ${binding.owner}/${binding.repo} ab — bitte im Profil korrigieren.`,
        retryable: true,
        cloneStatus: status,
        owner: binding.owner,
        repo: binding.repo,
        localPath
      }
    }
    if (status === 'error') {
      return {
        ready: false,
        action: 'needsRepo',
        message: 'Lokaler Repository-Pfad ist ungültig oder kein Git-Repository.',
        retryable: true,
        cloneStatus: status,
        localPath
      }
    }
  }

  if (!localPath) {
    return {
      ready: false,
      action: 'needsRepo',
      message: 'Kein lokales Arbeitsverzeichnis gesetzt.',
      retryable: true
    }
  }

  return { ready: true, localPath }
}
