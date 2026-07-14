import type { WorkspaceProfile } from '@shared/profile'

export interface WorkspaceProfileDeletionDependencies {
  getProfile(id: string): WorkspaceProfile | undefined
  hasRunningAgents(id: string): boolean
  deletePersistedProfile(id: string): WorkspaceProfile[]
  removeWorkspaceSessions(id: string): void
}

/**
 * Enforce the main-process deletion contract before mutating persisted or
 * in-memory workspace state. Persist first so a storage failure cannot discard
 * sessions for a profile that still exists.
 */
export function deleteWorkspaceProfile(
  id: unknown,
  dependencies: WorkspaceProfileDeletionDependencies
): WorkspaceProfile[] {
  if (typeof id !== 'string' || !dependencies.getProfile(id)) {
    throw new Error('Workspace-Profil nicht gefunden.')
  }
  if (dependencies.hasRunningAgents(id)) {
    throw new Error('Profil löschen ist während einer laufenden Agent-Session gesperrt.')
  }

  const profiles = dependencies.deletePersistedProfile(id)
  dependencies.removeWorkspaceSessions(id)
  return profiles
}
