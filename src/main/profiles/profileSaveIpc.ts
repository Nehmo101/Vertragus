import { workspaceProfileSchema, type WorkspaceProfile } from '@shared/profile'
import {
  assertAuthorizedRendererIpcSender,
  type RendererIpcAuthorizationOptions,
  type RendererIpcEventLike
} from '@main/security/ipcAuthorization'

export interface ProfileSaveIpcDependencies {
  authorization: RendererIpcAuthorizationOptions
}

/** Authorize the renderer before parsing any profile-controlled filesystem values. */
export function createProfileSaveIpcController(
  dependencies: ProfileSaveIpcDependencies
): {
  authorizeAndParse(event: RendererIpcEventLike, input: unknown): WorkspaceProfile
} {
  return {
    authorizeAndParse(event, input) {
      assertAuthorizedRendererIpcSender(
        event,
        dependencies.authorization,
        'Profil-Speicher-IPC: Zugriff verweigert (unauthorized).'
      )
      const parsed = workspaceProfileSchema.safeParse(input)
      if (!parsed.success) {
        const detail = parsed.error.issues[0]?.message ?? 'unbekannter Validierungsfehler'
        throw new Error(`Ungültiges Workspace-Profil: ${detail}`)
      }
      return parsed.data
    }
  }
}
