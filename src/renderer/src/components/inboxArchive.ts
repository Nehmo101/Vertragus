import {
  REMOVABLE_IDEA_ATTRIBUTES,
  type Idea,
  type IdeaArchiveView,
  type IdeaHistoryEntry,
  type RemovableIdeaAttribute
} from '@shared/inbox'

type RemovableRefKey = Exclude<RemovableIdeaAttribute, 'tags'>

export const REMOVABLE_REF_KEYS: RemovableRefKey[] = REMOVABLE_IDEA_ATTRIBUTES.filter(
  (attribute): attribute is RemovableRefKey => attribute !== 'tags'
)

export interface RemovableIdeaAttributeOption {
  id: string
  label: string
  value: string
  attribute: RemovableIdeaAttribute
}

export interface WorkspaceReference {
  label: string
  value: string
}

const REF_LABELS: Record<RemovableRefKey, string> = {
  profileId: 'Profil-ID',
  workspaceId: 'Workspace-ID',
  planId: 'Plan-ID',
  taskId: 'Task-ID'
}

const DATE_FORMATTER = new Intl.DateTimeFormat('de-DE', {
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit'
})

export function ideaTimestamp(idea: Idea, view: IdeaArchiveView): number {
  return view === 'archive' ? (idea.archivedAt ?? idea.updatedAt) : idea.updatedAt
}

export function ideaTimestampLabel(view: IdeaArchiveView): string {
  return view === 'archive' ? 'Archiviert' : 'Aktualisiert'
}

export function formatIdeaDate(timestamp: number): string {
  return Number.isFinite(timestamp) ? DATE_FORMATTER.format(timestamp) : '—'
}

export function ideasForView(ideas: Idea[], view: IdeaArchiveView): Idea[] {
  return ideas
    .filter((idea) =>
      view === 'archive' ? idea.status === 'archived' : idea.status !== 'archived'
    )
    .sort((left, right) => ideaTimestamp(right, view) - ideaTimestamp(left, view))
}

export function listRemovableIdeaAttributes(idea: Idea): RemovableIdeaAttributeOption[] {
  const tags = idea.tags.filter(Boolean)
  const tagOption = tags.length > 0
    ? [{
        id: 'attribute:tags',
        label: 'Tags',
        value: tags.join(', '),
        attribute: 'tags' as const
      }]
    : []
  const refs = REMOVABLE_REF_KEYS.flatMap((key) => {
    const value = idea.refs?.[key]
    return value
      ? [{
          id: `ref:${key}`,
          label: REF_LABELS[key],
          value,
          attribute: key
        }]
      : []
  })

  return [...tagOption, ...refs]
}

export function sortedIdeaHistory(idea: Idea): IdeaHistoryEntry[] {
  return [...(idea.history ?? [])].sort((left, right) => right.at - left.at)
}

export function workspaceReferences(idea: Idea): WorkspaceReference[] {
  return [
    idea.refs?.workspaceId
      ? { label: 'Workspace-ID', value: idea.refs.workspaceId }
      : undefined,
    idea.transfer?.workspaceSessionId
      ? { label: 'Workspace-Session-ID', value: idea.transfer.workspaceSessionId }
      : undefined
  ].filter((reference): reference is WorkspaceReference => Boolean(reference))
}
