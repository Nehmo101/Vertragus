import type { OrchestratorSnapshot, WorkspaceSessionSummary } from '@shared/orchestrator'
import {
  assertAuthorizedRendererIpcSender,
  type RendererIpcAuthorizationOptions,
  type RendererIpcEventLike
} from '@main/security/ipcAuthorization'

export interface WorkspaceSessionIpcDependencies {
  authorization: RendererIpcAuthorizationOptions
  list(profileId?: string): WorkspaceSessionSummary[]
  setActive(profileId: string, sessionId: string): OrchestratorSnapshot
  remove(profileId: string, sessionId: string): Promise<WorkspaceSessionSummary[]>
}

function requiredId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 256) {
    throw new Error(`Ungültige ${label} (invalid payload).`)
  }
  return value
}

/** Authorize and validate workspace-session IPC before reading or mutating state. */
export function createWorkspaceSessionIpcController(
  dependencies: WorkspaceSessionIpcDependencies
): {
  list(event: RendererIpcEventLike, profileId?: unknown): WorkspaceSessionSummary[]
  setActive(event: RendererIpcEventLike, profileId: unknown, sessionId: unknown): OrchestratorSnapshot
  remove(
    event: RendererIpcEventLike,
    profileId: unknown,
    sessionId: unknown
  ): Promise<WorkspaceSessionSummary[]>
} {
  const authorize = (event: RendererIpcEventLike): void =>
    assertAuthorizedRendererIpcSender(
      event,
      dependencies.authorization,
      'Workspace-Session-IPC: Zugriff verweigert (unauthorized).'
    )

  return {
    list(event, profileId) {
      authorize(event)
      if (profileId === undefined) return dependencies.list()
      return dependencies.list(requiredId(profileId, 'Profil-ID'))
    },
    setActive(event, profileId, sessionId) {
      authorize(event)
      return dependencies.setActive(
        requiredId(profileId, 'Profil-ID'),
        requiredId(sessionId, 'Workspace-Session-ID')
      )
    },
    async remove(event, profileId, sessionId) {
      authorize(event)
      return await dependencies.remove(
        requiredId(profileId, 'Profil-ID'),
        requiredId(sessionId, 'Workspace-Session-ID')
      )
    }
  }
}
