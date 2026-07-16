import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ideaSchema,
  type Idea,
  type RemovableIdeaAttribute
} from '@shared/inbox'
import {
  listArchivedIdeas,
  listInboxIdeas,
  sortNewestFirst
} from './archive'
import {
  __resetIdeasForTest,
  getIdea,
  listIdeas,
  removeIdeaAttribute,
  restoreIdea,
  updateIdea
} from './store'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/orca-archive-acceptance' }
}))

vi.mock('electron-store', () => ({
  default: class MemoryStore {
    private state: Record<string, unknown>

    constructor(options: { defaults?: Record<string, unknown> } = {}) {
      this.state = structuredClone(options.defaults ?? {})
    }

    get(key: string): unknown {
      return structuredClone(this.state[key])
    }

    set(key: string, value: unknown): void {
      this.state[key] = structuredClone(value)
    }
  }
}))

function makeTransfer(
  overrides: Partial<NonNullable<Idea['transfer']>> = {}
): NonNullable<Idea['transfer']> {
  return {
    id: 'transfer-1',
    status: 'running',
    profileId: 'profile-1',
    action: 'none',
    startedAt: 20,
    updatedAt: 30,
    ...overrides
  }
}

function makeIdea(overrides: Partial<Idea> = {}): Idea {
  return ideaSchema.parse({
    id: 'idea-1',
    title: 'Acceptance idea',
    content: 'Archive acceptance coverage',
    status: 'ready',
    tags: ['acceptance'],
    artifacts: [],
    createdAt: 1,
    updatedAt: 100,
    ...overrides
  })
}

function currentViews(): { inbox: Idea[]; archive: Idea[] } {
  const ideas = listIdeas()
  return {
    inbox: sortNewestFirst(listInboxIdeas(ideas), 'inbox'),
    archive: sortNewestFirst(listArchivedIdeas(ideas), 'archive')
  }
}

function workspaceLink(idea: Idea): string | undefined {
  return idea.refs?.workspaceId ?? idea.transfer?.workspaceSessionId
}

describe('idea archive acceptance', () => {
  beforeEach(() => {
    __resetIdeasForTest([])
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('moves a done idea from inbox to archive while preserving telemetry and history', () => {
    const transfer = makeTransfer({
      workspaceSessionId: 'workspace-session-1',
      planId: 'plan-1'
    })
    __resetIdeasForTest([
      makeIdea({
        id: 'processed',
        transfer,
        history: [
          { at: 1, kind: 'created' },
          { at: 20, kind: 'transferStarted', detail: 'running' }
        ]
      })
    ])
    vi.spyOn(Date, 'now').mockReturnValue(500)

    const archived = updateIdea({ id: 'processed', status: 'done' })
    const views = currentViews()

    expect(views.inbox.map(({ id }) => id)).not.toContain('processed')
    expect(views.archive.map(({ id }) => id)).toEqual(['processed'])
    expect(archived.transfer).toEqual(transfer)
    expect(views.archive[0].transfer).toEqual(transfer)
    expect(archived.history).toEqual([
      { at: 1, kind: 'created' },
      { at: 20, kind: 'transferStarted', detail: 'running' },
      { at: 500, kind: 'statusChanged', detail: 'ready -> done' },
      { at: 500, kind: 'archived' }
    ])
  })

  it('sorts inbox by updatedAt and archive by archivedAt, newest first', () => {
    __resetIdeasForTest([
      makeIdea({ id: 'inbox-middle', updatedAt: 200 }),
      makeIdea({ id: 'archive-newest', status: 'archived', updatedAt: 50, archivedAt: 500 }),
      makeIdea({ id: 'inbox-newest', status: 'draft', updatedAt: 300 }),
      makeIdea({ id: 'archive-oldest', status: 'archived', updatedAt: 900, archivedAt: 400 }),
      makeIdea({ id: 'inbox-oldest', updatedAt: 100 })
    ])

    const views = currentViews()

    expect(views.inbox.map(({ id }) => id)).toEqual([
      'inbox-newest',
      'inbox-middle',
      'inbox-oldest'
    ])
    expect(views.archive.map(({ id }) => id)).toEqual([
      'archive-newest',
      'archive-oldest'
    ])
  })

  it('removes tags and every supported ref sequentially with timestamps and history', () => {
    __resetIdeasForTest([
      makeIdea({
        tags: ['one', 'two'],
        refs: {
          profileId: 'profile-1',
          workspaceId: 'workspace-1',
          planId: 'plan-1',
          taskId: 'task-1'
        },
        history: [{ at: 1, kind: 'created' }]
      })
    ])
    const now = vi.spyOn(Date, 'now')
    const removals = [
      ['tags', 200],
      ['profileId', 300],
      ['workspaceId', 400],
      ['planId', 500],
      ['taskId', 600]
    ] as const

    for (const [attribute, at] of removals) {
      now.mockReturnValue(at)
      const updated = removeIdeaAttribute('idea-1', attribute)

      expect(updated.updatedAt).toBe(at)
      expect(updated.history?.at(-1)).toEqual({
        at,
        kind: 'attributeRemoved',
        detail: attribute
      })
      if (attribute === 'tags') {
        expect(updated.tags).toEqual([])
      } else {
        expect(updated.refs ?? {}).not.toHaveProperty(attribute)
      }
    }

    const finalIdea = getIdea('idea-1')
    expect(finalIdea?.tags).toEqual([])
    expect(finalIdea?.refs).toBeUndefined()
    expect(finalIdea?.history?.slice(1)).toEqual(
      removals.map(([detail, at]) => ({ at, kind: 'attributeRemoved', detail }))
    )
  })

  it.each([
    {
      source: 'refs.workspaceId',
      refs: { workspaceId: 'workspace-1' },
      transfer: undefined
    },
    {
      source: 'transfer.workspaceSessionId',
      refs: undefined,
      transfer: makeTransfer({ workspaceSessionId: 'workspace-1' })
    }
  ])('preserves the workspace link from $source across archiving', ({ refs, transfer }) => {
    const idea = makeIdea({ refs, transfer })
    __resetIdeasForTest([idea])
    vi.spyOn(Date, 'now').mockReturnValue(700)

    const before = workspaceLink(idea)
    const archived = updateIdea({ id: idea.id, status: 'done' })

    expect(before).toBe('workspace-1')
    expect(workspaceLink(archived)).toBe(before)
    expect(workspaceLink(currentViews().archive[0])).toBe(before)
  })

  it('restores an archived idea to the inbox view', () => {
    __resetIdeasForTest([
      makeIdea({
        id: 'restore-me',
        status: 'archived',
        archivedAt: 600,
        history: [{ at: 600, kind: 'archived' }]
      })
    ])
    expect(currentViews().inbox).toEqual([])
    expect(currentViews().archive.map(({ id }) => id)).toEqual(['restore-me'])
    vi.spyOn(Date, 'now').mockReturnValue(800)

    const restored = restoreIdea('restore-me')
    const views = currentViews()

    expect(restored).toMatchObject({ id: 'restore-me', status: 'ready', updatedAt: 800 })
    expect(restored.archivedAt).toBeUndefined()
    expect(views.inbox.map(({ id }) => id)).toEqual(['restore-me'])
    expect(views.archive).toEqual([])
  })

  it.each(['id', '__proto__', 'transfer'] as const)(
    'rejects unknown removable attribute %s without changing stored data',
    (attribute) => {
      __resetIdeasForTest([
        makeIdea({
          refs: { profileId: 'profile-1' },
          transfer: makeTransfer(),
          history: [{ at: 1, kind: 'created' }]
        })
      ])
      const before = getIdea('idea-1')

      expect(() =>
        removeIdeaAttribute('idea-1', attribute as RemovableIdeaAttribute)
      ).toThrow(/Unknown removable idea attribute/)
      expect(getIdea('idea-1')).toEqual(before)
    }
  )

  it('rejects an unknown idea id without changing stored data', () => {
    __resetIdeasForTest([makeIdea()])
    const before = listIdeas()

    expect(() => removeIdeaAttribute('missing-idea', 'tags')).toThrow(/Idee nicht gefunden/)
    expect(listIdeas()).toEqual(before)
  })

  it('continues to parse legacy ideas without archive timestamp or history', () => {
    const legacyIdea = {
      id: 'legacy',
      title: 'Legacy idea',
      content: '',
      status: 'draft' as const,
      tags: [],
      artifacts: [],
      createdAt: 1,
      updatedAt: 2
    }

    const parsed = ideaSchema.parse(legacyIdea)

    expect(parsed).toEqual(legacyIdea)
    expect(parsed.archivedAt).toBeUndefined()
    expect(parsed.history).toBeUndefined()
  })
})
