import type { WorkspaceProfile } from '@shared/profile'
import {
  assertAuthorizedRendererIpcSender,
  type RendererIpcAuthorizationOptions,
  type RendererIpcEventLike
} from '@main/security/ipcAuthorization'

export interface ProfileDeletionIpcDependencies {
  authorization: RendererIpcAuthorizationOptions
  deleteProfile(id: string): WorkspaceProfile[]
}

/** Authorize and validate before entering the state-mutating deletion service. */
export function createProfileDeletionIpcController(
  dependencies: ProfileDeletionIpcDependencies
): {
  delete(event: RendererIpcEventLike, input: unknown): WorkspaceProfile[]
} {
  return {
    delete(event, input) {
      assertAuthorizedRendererIpcSender(
        event,
        dependencies.authorization,
        'Profil-Lösch-IPC: Zugriff verweigert (unauthorized).'
      )
      if (typeof input !== 'string' || input.length === 0) {
        throw new Error('Ungültige Profil-ID (invalid payload).')
      }
      return dependencies.deleteProfile(input)
    }
  }
}
