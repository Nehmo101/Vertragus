/**
 * Pure filter helpers for the inbox idea list (search + status + tag).
 * Kept free of React so the logic is unit-testable in isolation.
 */
import { IDEA_STATUSES, type Idea, type IdeaStatus } from '@shared/inbox'

export interface InboxFilterCriteria {
  /** Free-text query, matched case-insensitively against title AND content. */
  query?: string
  /** Exact status match; null/undefined means "all statuses". */
  status?: IdeaStatus | null
  /** Exact tag match; null/undefined means "all tags". */
  tag?: string | null
}

/**
 * Filters ideas by free-text query (title + content, case-insensitive),
 * status and tag. All criteria are combined with AND; empty/omitted criteria
 * do not restrict the result. Preserves the incoming order.
 */
export function filterIdeas(ideas: Idea[], criteria: InboxFilterCriteria): Idea[] {
  const query = (criteria.query ?? '').trim().toLowerCase()
  const status = criteria.status ?? null
  const tag = criteria.tag ?? null
  if (!query && !status && !tag) return ideas

  return ideas.filter((idea) => {
    if (status && idea.status !== status) return false
    if (tag && !idea.tags.includes(tag)) return false
    if (query) {
      const haystack = `${idea.title}\n${idea.content}`.toLowerCase()
      if (!haystack.includes(query)) return false
    }
    return true
  })
}

/** True when any criterion actually restricts the list (used for the reset link). */
export function hasActiveFilter(criteria: InboxFilterCriteria): boolean {
  return Boolean((criteria.query ?? '').trim() || criteria.status || criteria.tag)
}

/** Unique, sorted list of every tag occurring in the given ideas. */
export function collectIdeaTags(ideas: Idea[]): string[] {
  const tags = new Set<string>()
  for (const idea of ideas) {
    for (const tag of idea.tags) {
      if (tag) tags.add(tag)
    }
  }
  return [...tags].sort((left, right) => left.localeCompare(right, 'de'))
}

/** Statuses that occur in the given ideas, in canonical IDEA_STATUSES order. */
export function collectIdeaStatuses(ideas: Idea[]): IdeaStatus[] {
  const present = new Set(ideas.map((idea) => idea.status))
  return IDEA_STATUSES.filter((status) => present.has(status))
}
