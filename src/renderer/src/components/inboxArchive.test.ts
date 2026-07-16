import { describe, expect, it } from 'vitest'
import type { Idea } from '@shared/inbox'
import {
  formatIdeaDate,
  ideaTimestamp,
  ideaTimestampLabel,
  ideasForView,
  listRemovableIdeaAttributes,
  sortedIdeaHistory,
  workspaceReferences,
  type ArchiveIdea
} from './inboxArchive'

function idea(overrides: Partial<ArchiveIdea>): ArchiveIdea {
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

describe('ideasForView', () => {
  it('keeps archived ideas out of the inbox and sorts by updatedAt descending', () => {
    const ideas = [
      idea({ id: 'old', updatedAt: 20 }),
      idea({ id: 'archived', status: 'archived', updatedAt: 50, archivedAt: 60 }),
      idea({ id: 'new', status: 'done', updatedAt: 40 })
    ]

    expect(ideasForView(ideas, 'inbox').map(({ id }) => id)).toEqual(['new', 'old'])
  })

  it('sorts the archive by archivedAt and falls back to updatedAt', () => {
    const ideas = [
      idea({ id: 'fallback', status: 'archived', updatedAt: 80 }),
      idea({ id: 'explicit', status: 'archived', updatedAt: 20, archivedAt: 100 }),
      idea({ id: 'inbox', updatedAt: 200 })
    ]

    expect(ideasForView(ideas, 'archive').map(({ id }) => id)).toEqual([
      'explicit',
      'fallback'
    ])
    expect(ideaTimestamp(ideas[0], 'archive')).toBe(80)
  })
})

describe('timestamp display', () => {
  it('uses view-specific labels and a readable German date', () => {
    expect(ideaTimestampLabel('inbox')).toBe('Aktualisiert')
    expect(ideaTimestampLabel('archive')).toBe('Archiviert')
    expect(formatIdeaDate(Date.UTC(2025, 3, 3, 12, 5))).toMatch(/03\.04\., \d{2}:\d{2}/)
    expect(formatIdeaDate(Number.NaN)).toBe('—')
  })
})

describe('listRemovableIdeaAttributes', () => {
  it('offers tags and only the supported reference attributes', () => {
    const refs = {
      profileId: 'profile-1',
      workspaceId: 'workspace-1',
      unknownId: 'must-not-be-offered'
    } as Idea['refs'] & { unknownId: string }
    const options = listRemovableIdeaAttributes(idea({ tags: ['ui'], refs }))

    expect(options.map(({ label, value }) => [label, value])).toEqual([
      ['Tags', 'ui'],
      ['Profil-ID', 'profile-1'],
      ['Workspace-ID', 'workspace-1']
    ])
    expect(options.map(({ attribute }) => attribute)).toEqual([
      'tags',
      'profileId',
      'workspaceId'
    ])
    expect(options.some(({ value }) => value === 'must-not-be-offered')).toBe(false)
  })
})

describe('archive metadata', () => {
  it('sorts history newest first without mutating it and exposes both workspace links', () => {
    const history = [
      { at: 10, kind: 'created' },
      { at: 30, kind: 'archived', detail: 'Manuell' }
    ]
    const archived = idea({
      history,
      refs: { workspaceId: 'workspace-1' },
      transfer: {
        id: 'transfer-1',
        status: 'planned',
        profileId: 'profile-1',
        startedAt: 5,
        updatedAt: 20,
        workspaceSessionId: 'session-1'
      }
    })

    expect(sortedIdeaHistory(archived).map(({ at }) => at)).toEqual([30, 10])
    expect(history.map(({ at }) => at)).toEqual([10, 30])
    expect(workspaceReferences(archived)).toEqual([
      { label: 'Workspace-ID', value: 'workspace-1' },
      { label: 'Workspace-Session-ID', value: 'session-1' }
    ])
  })
})
