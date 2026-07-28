import { describe, expect, it } from 'vitest'
import type { Idea } from '@shared/inbox'
import {
  collectIdeaStatuses,
  collectIdeaTags,
  filterIdeas,
  hasActiveFilter
} from './inboxFilter'

function idea(overrides: Partial<Idea>): Idea {
  return {
    id: 'idea-1',
    title: 'Idee',
    content: 'Inhalt',
    status: 'draft',
    tags: [],
    artifacts: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

const IDEAS: Idea[] = [
  idea({ id: 'a', title: 'Editor Umbau', content: 'Master-Detail Layout', status: 'draft', tags: ['ui'] }),
  idea({ id: 'b', title: 'Sprachnotiz', content: 'Transkript pruefen', status: 'ready', tags: ['sprache', 'ui'] }),
  idea({ id: 'c', title: 'Backlog', content: 'Alte Ideen sichten', status: 'done', tags: [] })
]

describe('filterIdeas', () => {
  it('returns the same array when no criterion is set', () => {
    expect(filterIdeas(IDEAS, {})).toBe(IDEAS)
    expect(filterIdeas(IDEAS, { query: '   ', status: null, tag: null })).toBe(IDEAS)
  })

  it('matches the query case-insensitively against title and content', () => {
    expect(filterIdeas(IDEAS, { query: 'EDITOR' }).map(({ id }) => id)).toEqual(['a'])
    expect(filterIdeas(IDEAS, { query: 'transkript' }).map(({ id }) => id)).toEqual(['b'])
    expect(filterIdeas(IDEAS, { query: '  layout ' }).map(({ id }) => id)).toEqual(['a'])
  })

  it('returns no ideas for a query without matches', () => {
    expect(filterIdeas(IDEAS, { query: 'nirgendwo' })).toEqual([])
  })

  it('filters by status', () => {
    expect(filterIdeas(IDEAS, { status: 'ready' }).map(({ id }) => id)).toEqual(['b'])
    expect(filterIdeas(IDEAS, { status: 'archived' })).toEqual([])
  })

  it('filters by tag', () => {
    expect(filterIdeas(IDEAS, { tag: 'ui' }).map(({ id }) => id)).toEqual(['a', 'b'])
    expect(filterIdeas(IDEAS, { tag: 'sprache' }).map(({ id }) => id)).toEqual(['b'])
    expect(filterIdeas(IDEAS, { tag: 'fehlt' })).toEqual([])
  })

  it('combines query, status and tag with AND', () => {
    expect(
      filterIdeas(IDEAS, { query: 'notiz', status: 'ready', tag: 'ui' }).map(({ id }) => id)
    ).toEqual(['b'])
    expect(filterIdeas(IDEAS, { query: 'notiz', status: 'draft', tag: 'ui' })).toEqual([])
    expect(filterIdeas(IDEAS, { query: 'editor', status: 'draft', tag: 'sprache' })).toEqual([])
  })

  it('preserves the incoming order', () => {
    expect(filterIdeas(IDEAS, { tag: 'ui' }).map(({ id }) => id)).toEqual(['a', 'b'])
  })
})

describe('hasActiveFilter', () => {
  it('is false for empty criteria and whitespace-only queries', () => {
    expect(hasActiveFilter({})).toBe(false)
    expect(hasActiveFilter({ query: '   ', status: null, tag: null })).toBe(false)
  })

  it('is true as soon as one criterion restricts the list', () => {
    expect(hasActiveFilter({ query: 'x' })).toBe(true)
    expect(hasActiveFilter({ status: 'draft' })).toBe(true)
    expect(hasActiveFilter({ tag: 'ui' })).toBe(true)
  })
})

describe('collectIdeaTags', () => {
  it('collects unique tags sorted alphabetically and skips empty ones', () => {
    const ideas = [...IDEAS, idea({ id: 'd', tags: ['ui', '', 'archiv'] })]
    expect(collectIdeaTags(ideas)).toEqual(['archiv', 'sprache', 'ui'])
  })

  it('returns an empty list when no idea has tags', () => {
    expect(collectIdeaTags([idea({ id: 'x' })])).toEqual([])
  })
})

describe('collectIdeaStatuses', () => {
  it('returns only present statuses in canonical order', () => {
    expect(collectIdeaStatuses(IDEAS)).toEqual(['draft', 'ready', 'done'])
    expect(collectIdeaStatuses([idea({ id: 'x', status: 'done' })])).toEqual(['done'])
    expect(collectIdeaStatuses([])).toEqual([])
  })
})
