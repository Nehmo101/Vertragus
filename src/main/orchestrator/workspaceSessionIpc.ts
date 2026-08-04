import type { OrchestratorSnapshot, WorkspaceSessionSummary } from '@shared/orchestrator'
import { assertIpcId } from '@shared/ipcValidation'
import {
  assertAuthorizedRendererIpcSender,
  type RendererIpcAuthorizationOptions,
  type RendererIpcEventLike
} from '@main/security/ipcAuthorization'

export interface WorkspaceSessionIpcDependencies {
  authorization: RendererIpcAuthorizationOptions
  /**
   * Optional weitere Autorisierung nur für das READ-Ende (list): Rail- und
   * Pane-Fenster rendern Session-Zustand und erhalten die Liste ohnehin über
   * den ev:workspaceSessions-Broadcast — der initiale Fetch darf sie deshalb
   * nicht aussperren (sonst stirbt die Store-Hydration in Sekundärfenstern).
   * Mutationen (setActive/remove) bleiben strikt bei `authorization`.
   */
  readAuthorization?: RendererIpcAuthorizationOptions
  list(profileId?: string): WorkspaceSessionSummary[]
  setActive(profileId: string, sessionId: string): OrchestratorSnapshot
  remove(profileId: string, sessionId: string): Promise<WorkspaceSessionSummary[]>
}


const requiredId = (value: unknown, label: string): string => assertIpcId(value, label)

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
  const authorizeRead = (event: RendererIpcEventLike): void =>
    assertAuthorizedRendererIpcSender(
      event,
      dependencies.readAuthorization ?? dependencies.authorization,
      'Workspace-Session-IPC: Zugriff verweigert (unauthorized).'
    )

  return {
    list(event, profileId) {
      authorizeRead(event)
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
