import type { Idea } from '@shared/inbox'

export type IdeaHistoryEntry = {
  at: number
  kind:
    | 'created'
    | 'statusChanged'
    | 'transferStarted'
    | 'transferUpdated'
    | 'archived'
    | 'restored'
    | 'attributeRemoved'
  detail?: string
}

export type ArchiveIdea = Idea & {
  archivedAt?: number
  history?: IdeaHistoryEntry[]
}

export const REMOVABLE_IDEA_ATTRIBUTES = [
  'tags',
  'profileId',
  'workspaceId',
  'planId',
  'taskId'
] as const

export type RemovableIdeaAttribute = (typeof REMOVABLE_IDEA_ATTRIBUTES)[number]
export type IdeaArchiveView = 'inbox' | 'archive'

const REF_ATTRIBUTES: Exclude<RemovableIdeaAttribute, 'tags'>[] = [
  'profileId',
  'workspaceId',
  'planId',
  'taskId'
]

function assertRemovableAttribute(attribute: string): asserts attribute is RemovableIdeaAttribute {
  if (!REMOVABLE_IDEA_ATTRIBUTES.some((allowed) => allowed === attribute)) {
    throw new Error(`Unknown removable idea attribute: ${attribute}`)
  }
}

export function appendHistory(idea: ArchiveIdea, entry: IdeaHistoryEntry): ArchiveIdea {
  return {
    ...idea,
    history: [...(idea.history ?? []), entry]
  }
}

export function isProcessed(idea: Idea): boolean {
  return idea.status === 'done'
}

export function archiveIdea(idea: ArchiveIdea, now: number): ArchiveIdea {
  if (idea.status === 'archived') {
    throw new Error('Idea is already archived.')
  }

  return appendHistory(
    {
      ...idea,
      status: 'archived',
      archivedAt: now
    },
    { at: now, kind: 'archived' }
  )
}

export function restoreIdea(idea: ArchiveIdea, now: number): ArchiveIdea {
  if (idea.status !== 'archived') {
    throw new Error('Only archived ideas can be restored.')
  }

  const restored: ArchiveIdea = {
    ...idea,
    status: 'ready'
  }
  delete restored.archivedAt

  return appendHistory(restored, { at: now, kind: 'restored' })
}

export function autoArchiveProcessed(
  ideas: readonly ArchiveIdea[],
  now: number
): { ideas: ArchiveIdea[]; archivedIds: string[] } {
  const archivedIds: string[] = []
  const archivedIdeas = ideas.map((idea) => {
    if (!isProcessed(idea)) return idea
    archivedIds.push(idea.id)
    return archiveIdea(idea, now)
  })

  return { ideas: archivedIdeas, archivedIds }
}

export function removeIdeaAttribute(
  idea: ArchiveIdea,
  attribute: RemovableIdeaAttribute,
  now: number
): ArchiveIdea {
  assertRemovableAttribute(attribute)

  if (attribute === 'tags') {
    return appendHistory(
      { ...idea, tags: [], updatedAt: now },
      { at: now, kind: 'attributeRemoved', detail: attribute }
    )
  }

  const refs = { ...idea.refs }
  delete refs[attribute]
  for (const key of REF_ATTRIBUTES) {
    if (refs[key] === undefined) delete refs[key]
  }

  return appendHistory(
    {
      ...idea,
      refs: Object.keys(refs).length > 0 ? refs : undefined,
      updatedAt: now
    },
    { at: now, kind: 'attributeRemoved', detail: attribute }
  )
}

export function sortNewestFirst(
  ideas: readonly ArchiveIdea[],
  view: IdeaArchiveView
): ArchiveIdea[] {
  return [...ideas].sort((left, right) => {
    const leftAt = view === 'archive' ? (left.archivedAt ?? left.updatedAt) : left.updatedAt
    const rightAt = view === 'archive' ? (right.archivedAt ?? right.updatedAt) : right.updatedAt
    return rightAt - leftAt
  })
}

export function listInboxIdeas(ideas: readonly ArchiveIdea[]): ArchiveIdea[] {
  return ideas.filter((idea) => idea.status !== 'archived')
}

export function listArchivedIdeas(ideas: readonly ArchiveIdea[]): ArchiveIdea[] {
  return ideas.filter((idea) => idea.status === 'archived')
}
