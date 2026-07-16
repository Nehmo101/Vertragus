import { describe, expect, it } from 'vitest'
import {
  IDEA_INPUT_STATUSES,
  enrichArtifact,
  enrichIdea,
  ideaSchema,
  isValidUrl,
  normalizeTags
} from './inbox'

describe('inbox validation', () => {
  it('keeps archived out of renderer-controlled status inputs', () => {
    expect(IDEA_INPUT_STATUSES).toEqual(['draft', 'ready', 'done'])
    expect(IDEA_INPUT_STATUSES).not.toContain('archived')
  })

  it('accepts http and https URLs with host', () => {
    expect(isValidUrl('https://example.com/path')).toBe(true)
    expect(isValidUrl('http://localhost:3000')).toBe(true)
    expect(isValidUrl('ftp://example.com')).toBe(false)
    expect(isValidUrl('not-a-url')).toBe(false)
    expect(isValidUrl('')).toBe(false)
  })

  it('normalizes and deduplicates tags', () => {
    expect(normalizeTags([' Foo ', 'bar', 'FOO', ''])).toEqual(['foo', 'bar'])
    expect(normalizeTags('Alpha, beta, ALPHA')).toEqual(['alpha', 'beta'])
  })

  it('parses legacy persisted ideas without archive metadata', () => {
    const parsed = ideaSchema.parse({
      id: 'legacy',
      title: 'Legacy',
      content: '',
      status: 'ready',
      tags: [],
      artifacts: [],
      createdAt: 1,
      updatedAt: 2
    })

    expect(parsed.archivedAt).toBeUndefined()
    expect(parsed.history).toBeUndefined()
  })

  it('validates archive timestamps and the closed history-kind enum', () => {
    const base = {
      id: 'archived',
      title: 'Archived',
      content: '',
      status: 'archived',
      tags: [],
      artifacts: [],
      archivedAt: 3,
      createdAt: 1,
      updatedAt: 2
    }

    expect(ideaSchema.parse({
      ...base,
      history: [{ at: 3, kind: 'archived', detail: 'auto' }]
    }).history).toEqual([{ at: 3, kind: 'archived', detail: 'auto' }])
    expect(() => ideaSchema.parse({
      ...base,
      history: [{ at: 3, kind: 'unknown' }]
    })).toThrow()
  })

  it('flags invalid URLs and missing files on enrich', () => {
    const idea = ideaSchema.parse({
      id: 'i1',
      title: 'Test',
      content: '',
      status: 'draft',
      tags: [],
      artifacts: [
        {
          id: 'a1',
          kind: 'url',
          label: 'Link',
          createdAt: 1,
          url: 'bad'
        },
        {
          id: 'a2',
          kind: 'file',
          label: 'Doc',
          createdAt: 1,
          sourcePath: '/missing.txt'
        }
      ],
      createdAt: 1,
      updatedAt: 1
    })
    const enriched = enrichIdea(idea, () => false)
    expect(enriched.artifacts[0].urlInvalid).toBe(true)
    expect(enriched.artifacts[1].missing).toBe(true)
  })

  it('marks present managed files as available', () => {
    const artifact = enrichArtifact(
      {
        id: 'a1',
        kind: 'file',
        label: 'Doc',
        createdAt: 1,
        storedPath: '/data/inbox/x.pdf'
      },
      (p) => p === '/data/inbox/x.pdf'
    )
    expect(artifact.missing).toBe(false)
  })
})
