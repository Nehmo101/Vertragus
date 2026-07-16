import { describe, expect, it } from 'vitest'
import type { Idea } from '@shared/inbox'
import {
  appendHistory,
  archiveIdea,
  autoArchiveProcessed,
  isProcessed,
  listArchivedIdeas,
  listInboxIdeas,
  removeIdeaAttribute,
  restoreIdea,
  sortNewestFirst,
  type ArchiveIdea,
  type RemovableIdeaAttribute
} from './archive'

function makeIdea(overrides: Partial<ArchiveIdea> = {}): ArchiveIdea {
  const idea: Idea = {
    id: 'idea-1',
    title: 'Archive feature',
    content: 'Keep all linked data.',
    status: 'ready',
    tags: ['inbox', 'archive'],
    refs: {
      profileId: 'profile-1',
      workspaceId: 'workspace-1',
      planId: 'plan-1',
      taskId: 'task-1'
    },
    artifacts: [
      {
        id: 'artifact-1',
        kind: 'url',
        label: 'Specification',
        createdAt: 10,
        url: 'https://example.com/specification'
      }
    ],
    transfer: {
      id: 'transfer-1',
      status: 'planned',
      profileId: 'profile-1',
      startedAt: 20,
      updatedAt: 30,
      planId: 'plan-1'
    },
    createdAt: 1,
    updatedAt: 100
  }

  return { ...idea, ...overrides }
}

describe('idea archive helpers', () => {
  it('recognizes only done ideas as processed', () => {
    expect(isProcessed(makeIdea({ status: 'done' }))).toBe(true)

    for (const status of ['draft', 'ready', 'archived'] as const) {
      expect(isProcessed(makeIdea({ status }))).toBe(false)
    }
  })

  it('appends history without mutating the idea or its existing history', () => {
    const history = [{ at: 1, kind: 'created' as const }]
    const idea = makeIdea({ history })
    const entry = { at: 2, kind: 'statusChanged' as const, detail: 'ready' }

    const result = appendHistory(idea, entry)

    expect(result.history).toEqual([...history, entry])
    expect(result.history).not.toBe(history)
    expect(idea.history).toBe(history)
  })

  it('archives an idea and preserves refs, tags, artifacts, and transfer telemetry', () => {
    const idea = makeIdea({
      status: 'done',
      history: [{ at: 1, kind: 'created' }]
    })

    const result = archiveIdea(idea, 500)

    expect(result).toMatchObject({
      status: 'archived',
      archivedAt: 500,
      refs: idea.refs,
      tags: idea.tags,
      artifacts: idea.artifacts,
      transfer: idea.transfer,
      history: [
        { at: 1, kind: 'created' },
        { at: 500, kind: 'archived' }
      ]
    })
    expect(idea.status).toBe('done')
    expect(idea).not.toHaveProperty('archivedAt')
  })

  it('rejects archiving an already archived idea', () => {
    const idea = makeIdea({ status: 'archived', archivedAt: 400 })

    expect(() => archiveIdea(idea, 500)).toThrow(/already archived/)
  })

  it('restores an archived idea to ready and removes archivedAt', () => {
    const idea = makeIdea({
      status: 'archived',
      archivedAt: 400,
      history: [{ at: 400, kind: 'archived' }]
    })

    const result = restoreIdea(idea, 600)

    expect(result.status).toBe('ready')
    expect(result).not.toHaveProperty('archivedAt')
    expect(result.history).toEqual([
      { at: 400, kind: 'archived' },
      { at: 600, kind: 'restored' }
    ])
    expect(idea.archivedAt).toBe(400)
  })

  it('rejects restoring a non-archived idea', () => {
    expect(() => restoreIdea(makeIdea(), 600)).toThrow(/Only archived/)
  })

  it('automatically archives all processed ideas while leaving others untouched', () => {
    const doneOne = makeIdea({ id: 'done-1', status: 'done' })
    const ready = makeIdea({ id: 'ready-1', status: 'ready' })
    const archived = makeIdea({ id: 'archived-1', status: 'archived', archivedAt: 200 })
    const doneTwo = makeIdea({ id: 'done-2', status: 'done' })

    const result = autoArchiveProcessed([doneOne, ready, archived, doneTwo], 700)

    expect(result.archivedIds).toEqual(['done-1', 'done-2'])
    expect(result.ideas.map((idea) => idea.status)).toEqual([
      'archived',
      'ready',
      'archived',
      'archived'
    ])
    expect(result.ideas[0]).toMatchObject({
      archivedAt: 700,
      history: [{ at: 700, kind: 'archived' }]
    })
    expect(result.ideas[1]).toBe(ready)
    expect(result.ideas[2]).toBe(archived)
  })

  it('handles an empty auto-archive input', () => {
    expect(autoArchiveProcessed([], 700)).toEqual({ ideas: [], archivedIds: [] })
  })

  it('removes all tags, updates the timestamp, and records history', () => {
    const idea = makeIdea()

    const result = removeIdeaAttribute(idea, 'tags', 800)

    expect(result.tags).toEqual([])
    expect(result.updatedAt).toBe(800)
    expect(result.history).toEqual([
      { at: 800, kind: 'attributeRemoved', detail: 'tags' }
    ])
    expect(idea.tags).toEqual(['inbox', 'archive'])
  })

  it.each(['profileId', 'workspaceId', 'planId', 'taskId'] as const)(
    'removes the %s ref without changing the remaining refs',
    (attribute) => {
      const idea = makeIdea()

      const result = removeIdeaAttribute(idea, attribute, 900)

      expect(result.refs).not.toHaveProperty(attribute)
      expect(result.refs).toEqual({
        ...idea.refs,
        [attribute]: undefined
      })
      expect(result.updatedAt).toBe(900)
      expect(result.history).toEqual([
        { at: 900, kind: 'attributeRemoved', detail: attribute }
      ])
      expect(idea.refs).toHaveProperty(attribute)
    }
  )

  it('removes an empty refs object entirely', () => {
    const idea = makeIdea({ refs: { workspaceId: 'workspace-1' } })

    const result = removeIdeaAttribute(idea, 'workspaceId', 901)

    expect(result.refs).toBeUndefined()
  })

  it('rejects attributes outside the runtime allowlist', () => {
    const unknownAttribute = 'transfer' as RemovableIdeaAttribute

    expect(() => removeIdeaAttribute(makeIdea(), unknownAttribute, 1_000)).toThrow(
      /Unknown removable idea attribute/
    )
  })

  it('sorts inbox ideas by updatedAt without mutating the input', () => {
    const oldIdea = makeIdea({ id: 'old', updatedAt: 100 })
    const newIdea = makeIdea({ id: 'new', updatedAt: 300 })
    const middleIdea = makeIdea({ id: 'middle', updatedAt: 200 })
    const input = [oldIdea, newIdea, middleIdea]

    const result = sortNewestFirst(input, 'inbox')

    expect(result.map((idea) => idea.id)).toEqual(['new', 'middle', 'old'])
    expect(input.map((idea) => idea.id)).toEqual(['old', 'new', 'middle'])
  })

  it('sorts archive ideas by archivedAt with updatedAt as fallback', () => {
    const fallback = makeIdea({ id: 'fallback', status: 'archived', updatedAt: 250 })
    const newest = makeIdea({
      id: 'newest',
      status: 'archived',
      updatedAt: 100,
      archivedAt: 300
    })
    const oldest = makeIdea({
      id: 'oldest',
      status: 'archived',
      updatedAt: 500,
      archivedAt: 200
    })

    const result = sortNewestFirst([oldest, fallback, newest], 'archive')

    expect(result.map((idea) => idea.id)).toEqual(['newest', 'fallback', 'oldest'])
  })

  it('filters inbox and archive views without changing their order', () => {
    const draft = makeIdea({ id: 'draft', status: 'draft' })
    const archivedOne = makeIdea({ id: 'archived-1', status: 'archived' })
    const done = makeIdea({ id: 'done', status: 'done' })
    const archivedTwo = makeIdea({ id: 'archived-2', status: 'archived' })

    expect(listInboxIdeas([draft, archivedOne, done, archivedTwo])).toEqual([draft, done])
    expect(listArchivedIdeas([draft, archivedOne, done, archivedTwo])).toEqual([
      archivedOne,
      archivedTwo
    ])
    expect(listInboxIdeas([])).toEqual([])
    expect(listArchivedIdeas([])).toEqual([])
  })
})
