import {
  promptEnhancementAbortSchema,
  promptEnhancementRequestSchema,
  promptEnhancementResultSchema,
  type PromptEnhancementIpcRequest,
  type PromptEnhancementIpcResult
} from '@shared/promptEnhancement'
import type { WorkspaceProfile } from '@shared/profile'
import { isTrustedRendererUrl } from '@main/security/navigation'
import type { MainPromptEnhancementService } from './promptEnhancementProvider'
import type { VerifiedPromptWorkspaceContext } from './promptEnhancement'

export interface PromptIpcWebContentsLike {
  id: number
  isDestroyed(): boolean
  getURL(): string
  mainFrame: unknown
}

export interface PromptIpcEventLike {
  sender: PromptIpcWebContentsLike
  senderFrame: { url?: string } | null
}

export interface PromptIpcAuthorizationOptions {
  developmentUrl?: string
  packagedRendererUrl?: string
  isKnownSender(sender: PromptIpcWebContentsLike): boolean
}

/** Fail closed for unknown windows, subframes, destroyed senders and foreign origins. */
export function assertAuthorizedPromptEnhancementSender(
  event: PromptIpcEventLike,
  options: PromptIpcAuthorizationOptions
): void {
  const { sender, senderFrame } = event
  const frameUrl = senderFrame?.url || sender.getURL()
  const isMainFrame = Boolean(senderFrame) && senderFrame === sender.mainFrame
  if (
    sender.isDestroyed() ||
    !options.isKnownSender(sender) ||
    !isMainFrame ||
    !isTrustedRendererUrl(frameUrl, options.developmentUrl, options.packagedRendererUrl)
  ) {
    throw new Error('Prompt-Verbesserungs-IPC: Zugriff verweigert (unauthorized).')
  }
}

export interface PromptEnhancementIpcDependencies {
  authorize(event: PromptIpcEventLike): void
  getProfile(id: string): WorkspaceProfile | undefined
  inspectWorkspace(profile: WorkspaceProfile): Promise<VerifiedPromptWorkspaceContext>
  service: MainPromptEnhancementService
}

function invalidWorkspace(message: string): PromptEnhancementIpcResult {
  return {
    status: 'invalid-input',
    code: 'invalid-workspace-context',
    message
  }
}

/** Main-owned request/abort coordinator, injectable for IPC tests. */
export function createPromptEnhancementIpcController(
  dependencies: PromptEnhancementIpcDependencies
): {
  enhance(event: PromptIpcEventLike, input: unknown): Promise<PromptEnhancementIpcResult>
  abort(event: PromptIpcEventLike, input: unknown): boolean
  activeCount(): number
} {
  const controllers = new Map<string, AbortController>()
  const keyFor = (senderId: number, requestId: string): string => `${senderId}:${requestId}`

  return {
    async enhance(event, input) {
      dependencies.authorize(event)
      const parsed = promptEnhancementRequestSchema.safeParse(input)
      if (!parsed.success) throw new Error('Ungültige Prompt-Verbesserungsanfrage (invalid payload).')
      const request: PromptEnhancementIpcRequest = parsed.data
      const key = keyFor(event.sender.id, request.requestId)
      if (controllers.has(key)) {
        throw new Error('Ungültige Request-ID: Für diesen Aufruf läuft bereits eine Anfrage.')
      }
      const controller = new AbortController()
      controllers.set(key, controller)
      try {
        const profileId = request.source.refs?.profileId
        const profile = profileId ? dependencies.getProfile(profileId) : undefined
        if (profileId && !profile) {
          return invalidWorkspace('Das verknüpfte Workspace-Profil wurde nicht gefunden.')
        }

        let workspace: VerifiedPromptWorkspaceContext | undefined
        if (profile) {
          try {
            workspace = await dependencies.inspectWorkspace(profile)
          } catch {
            return invalidWorkspace(
              'Der verknüpfte Workspace konnte nicht sicher und read-only geprüft werden.'
            )
          }
        }
        if (controller.signal.aborted) {
          return { status: 'aborted', message: 'Die Prompt-Verbesserung wurde abgebrochen.' }
        }

        const result = await dependencies.service.enhance({
          source: request.source,
          profile,
          workspace,
          explicitSelection: request.explicitSelection,
          signal: controller.signal
        })
        const validated = promptEnhancementResultSchema.safeParse(result)
        if (!validated.success) {
          return {
            status: 'invalid-input',
            code: 'invalid-input',
            message: 'Die Main-Prozess-Antwort hatte ein ungültiges Format.'
          }
        }
        return validated.data
      } finally {
        controllers.delete(key)
      }
    },

    abort(event, input) {
      dependencies.authorize(event)
      const parsed = promptEnhancementAbortSchema.safeParse(input)
      if (!parsed.success) throw new Error('Ungültige Abbruchanfrage (invalid payload).')
      const key = keyFor(event.sender.id, parsed.data.requestId)
      const controller = controllers.get(key)
      if (!controller) return false
      controller.abort()
      return true
    },

    activeCount: () => controllers.size
  }
}
