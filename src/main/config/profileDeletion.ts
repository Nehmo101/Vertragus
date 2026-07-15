import { DEFAULT_PROFILE, type WorkspaceProfile } from '@shared/profile'

export interface ProfileDeletionState {
  profiles: WorkspaceProfile[]
  activeProfileId: string
}

/** Apply the existing persistence rules without touching electron-store. */
export function deriveProfileDeletion(
  profiles: WorkspaceProfile[],
  activeProfileId: string,
  id: string
): ProfileDeletionState {
  if (!profiles.some((profile) => profile.id === id)) {
    throw new Error('Workspace-Profil nicht gefunden.')
  }

  const remaining = profiles.filter((profile) => profile.id !== id)
  const nextProfiles = remaining.length > 0 ? remaining : [DEFAULT_PROFILE]
  return {
    profiles: nextProfiles,
    activeProfileId: activeProfileId === id ? nextProfiles[0].id : activeProfileId
  }
}
