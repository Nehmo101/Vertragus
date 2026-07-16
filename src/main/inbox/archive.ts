import {
  REMOVABLE_IDEA_ATTRIBUTES,
  type Idea,
  type IdeaArchiveView,
  type IdeaHistoryEntry,
  type RemovableIdeaAttribute
} from '@shared/inbox'

const REF_ATTRIBUTES: Exclude<RemovableIdeaAttribute, 'tags'>[] = [
  'profileId',
  'workspaceId',
  'planId',
  'taskId'
]
const MAX_HISTORY_ENTRIES = 100

function assertRemovableAttribute(attribute: string): asserts attribute is RemovableIdeaAttribute {
  if (!REMOVABLE_IDEA_ATTRIBUTES.some((allowed) => allowed === attribute)) {
    throw new Error(`Unknown removable idea attribute: ${attribute}`)
  }
}

export function appendHistory(idea: Idea, entry: IdeaHistoryEntry): Idea {
  const history = [...(idea.history ?? []), entry]
  return {
    ...idea,
    history: history.slice(-MAX_HISTORY_ENTRIES)
  }
}

export function isProcessed(idea: Idea): boolean {
  return idea.status === 'done'
}

export function archiveIdea(idea: Idea, now: number): Idea {
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

export function restoreIdea(idea: Idea, now: number): Idea {
  if (idea.status !== 'archived') {
    throw new Error('Only archived ideas can be restored.')
  }

  const restored: Idea = {
    ...idea,
    status: 'ready',
    updatedAt: now
  }
  delete restored.archivedAt

  return appendHistory(restored, { at: now, kind: 'restored' })
}

export function autoArchiveProcessed(
  ideas: readonly Idea[],
  now: number
): { ideas: Idea[]; archivedIds: string[] } {
  const archivedIds: string[] = []
  const archivedIdeas = ideas.map((idea) => {
    if (!isProcessed(idea)) return idea
    archivedIds.push(idea.id)
    return archiveIdea(idea, now)
  })

  return { ideas: archivedIdeas, archivedIds }
}

export function removeIdeaAttribute(
  idea: Idea,
  attribute: RemovableIdeaAttribute,
  now: number
): Idea {
  assertRemovableAttribute(attribute)

  if (attribute === 'tags') {
    if (idea.tags.length === 0) return idea
    return appendHistory(
      { ...idea, tags: [], updatedAt: now },
      { at: now, kind: 'attributeRemoved', detail: attribute }
    )
  }

  if (idea.refs?.[attribute] === undefined) return idea
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

export function sortNewestFirst(ideas: readonly Idea[], view: IdeaArchiveView): Idea[] {
  return [...ideas].sort((left, right) => {
    const leftAt = view === 'archive' ? (left.archivedAt ?? left.updatedAt) : left.updatedAt
    const rightAt = view === 'archive' ? (right.archivedAt ?? right.updatedAt) : right.updatedAt
    return rightAt - leftAt
  })
}

export function listInboxIdeas(ideas: readonly Idea[]): Idea[] {
  return ideas.filter((idea) => idea.status !== 'archived')
}

export function listArchivedIdeas(ideas: readonly Idea[]): Idea[] {
  return ideas.filter((idea) => idea.status === 'archived')
}
