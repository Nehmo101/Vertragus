import {
  removableIdeaAttributeSchema,
  type Idea,
  type RemovableIdeaAttribute
} from '@shared/inbox'
import {
  assertAuthorizedRendererIpcSender,
  type RendererIpcAuthorizationOptions,
  type RendererIpcEventLike
} from '@main/security/ipcAuthorization'
import { z } from 'zod'

const ideaIdSchema = z.string().min(1)

export type ArchiveIpcEventLike = RendererIpcEventLike
export type ArchiveIpcAuthorizationOptions = RendererIpcAuthorizationOptions

/** Fail closed for unknown windows, subframes, destroyed senders and foreign origins. */
export function assertAuthorizedInboxArchiveSender(
  event: ArchiveIpcEventLike,
  options: ArchiveIpcAuthorizationOptions
): void {
  assertAuthorizedRendererIpcSender(
    event,
    options,
    'Ideen-Archiv-IPC: Zugriff verweigert (unauthorized).'
  )
}

export interface InboxArchiveIpcDependencies {
  authorize(event: ArchiveIpcEventLike): void
  removeAttribute(ideaId: string, attribute: RemovableIdeaAttribute): Idea
  restoreIdea(ideaId: string): Idea
}

export function createInboxArchiveIpcController(
  dependencies: InboxArchiveIpcDependencies
): {
  removeAttribute(event: ArchiveIpcEventLike, ideaId: unknown, attribute: unknown): Idea
  restoreIdea(event: ArchiveIpcEventLike, ideaId: unknown): Idea
} {
  return {
    removeAttribute(event, ideaId, attribute) {
      dependencies.authorize(event)
      const parsedIdeaId = ideaIdSchema.safeParse(ideaId)
      const parsedAttribute = removableIdeaAttributeSchema.safeParse(attribute)
      if (!parsedIdeaId.success || !parsedAttribute.success) {
        throw new Error('Ungültige Anfrage zum Entfernen eines Ideen-Attributs.')
      }
      return dependencies.removeAttribute(parsedIdeaId.data, parsedAttribute.data)
    },

    restoreIdea(event, ideaId) {
      dependencies.authorize(event)
      const parsedIdeaId = ideaIdSchema.safeParse(ideaId)
      if (!parsedIdeaId.success) {
        throw new Error('Ungültige Anfrage zum Wiederherstellen einer Idee.')
      }
      return dependencies.restoreIdea(parsedIdeaId.data)
    }
  }
}
