/**
 * Pure profile repository readiness checks for inbox → workspace transfer.
 */
import type { ProfileCloneStatus, WorkspaceProfile } from '@shared/profile'
import { profileRepoLocalPath } from '@shared/profile'
import type { IdeaTransferAction } from '@shared/inboxTransfer'

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

export function assessProfileOrchestrator(
  profile: WorkspaceProfile
): { ok: true } | { ok: false; message: string } {
  if (!profile.orchestrator) {
    return {
      ok: false,
      message: 'Profil hat keinen Orchestrator — Übergabe benötigt Planungs-Modus.'
    }
  }
  if (profile.planner.mode === 'manual') {
    return {
      ok: false,
      message: 'Planner-Modus ist „manuell" — execute_plan ist deaktiviert.'
    }
  }
  return { ok: true }
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
