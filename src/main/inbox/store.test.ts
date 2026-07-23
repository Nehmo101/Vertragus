import { describe, expect, it, vi, beforeEach } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import {
  ideaSchema,
  MAX_IMAGE_ARTIFACT_BYTES,
  type CreateIdeaInput,
  type UpdateIdeaInput
} from '@shared/inbox'
import { ideaTransferSchema } from '@shared/inboxTransfer'
import {
  __resetIdeasForTest,
  addArtifact,
  applyIdeaTransfer,
  createIdea,
  getIdea,
  listIdeas,
  removeIdeaAttribute,
  resetIdeaTransfer,
  restoreIdea,
  updateIdea
} from './store'

/** 1×1 transparent PNG. */
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

vi.mock('electron', () => ({
  app: { getPath: () => `/tmp/vertragus-test-userdata-${process.pid}` }
}))

vi.mock('electron-store', async (importOriginal) => {
  const [{ default: ElectronStore }, { tmpdir }, { join }] = await Promise.all([
    importOriginal<{ default: typeof import('electron-store') }>(),
    import('node:os'),
    import('node:path')
  ])
  const testCwd = join(tmpdir(), `vertragus-test-userdata-${process.pid}`)
  return {
    default: class TestElectronStore extends ElectronStore {
      constructor(options: ConstructorParameters<typeof ElectronStore>[0]) {
        super({ ...options, cwd: testCwd })
      }
    }
  }
})

describe('inbox store security', () => {
  beforeEach(() => {
    __resetIdeasForTest([])
  })

  it('updateIdea ignores transfer payloads from renderer IPC', () => {
    const idea = createIdea({ title: 'Secure' })
    const maliciousTransfer = ideaTransferSchema.parse({
      id: 'evil-transfer',
      status: 'running',
      profileId: 'prof-evil',
      action: 'none',
      startedAt: Date.now(),
      updatedAt: Date.now()
    })
    const updated = updateIdea({
      id: idea.id,
      title: 'Updated',
      // Simulate compromised renderer sending transfer via ideas:update
      ...({ transfer: maliciousTransfer } as Record<string, unknown>)
    } as Parameters<typeof updateIdea>[0])
    expect(updated.title).toBe('Updated')
    expect(updated.transfer).toBeUndefined()
  })

  it('rejects renderer attempts to set the archived status directly', () => {
    const idea = createIdea({ title: 'Main-only archive', status: 'ready' })
    const archivedCreate = { status: 'archived' } as unknown as CreateIdeaInput
    const archivedUpdate = {
      id: idea.id,
      status: 'archived'
    } as unknown as UpdateIdeaInput

    expect(() => createIdea(archivedCreate)).toThrow(/Main-Archivoperation/)
    expect(() => updateIdea(archivedUpdate)).toThrow(/Main-Archivoperation/)
    expect(getIdea(idea.id)?.status).toBe('ready')
  })

  it('auto-archives done ideas on create and requires the restore operation to leave archive', () => {
    const archived = createIdea({ title: 'Already processed', status: 'done' })

    expect(archived).toMatchObject({
      status: 'archived',
      archivedAt: expect.any(Number)
    })
    expect(archived.history?.map(({ kind }) => kind)).toEqual(['created', 'archived'])
    expect(() => updateIdea({ id: archived.id, status: 'ready' })).toThrow(
      /Main-Operation/
    )
    expect(getIdea(archived.id)).toMatchObject({
      status: 'archived',
      archivedAt: expect.any(Number)
    })
  })

  it('normalizes legacy archive metadata while the shared schema stays backward compatible', () => {
    __resetIdeasForTest([
      ideaSchema.parse({
        id: 'legacy-archive',
        title: 'Legacy archive',
        content: '',
        status: 'archived',
        tags: [],
        artifacts: [],
        createdAt: 1,
        updatedAt: 10
      }),
      ideaSchema.parse({
        id: 'legacy-active',
        title: 'Legacy active',
        content: '',
        status: 'ready',
        tags: [],
        artifacts: [],
        archivedAt: 5,
        createdAt: 2,
        updatedAt: 20
      })
    ])

    const ideas = listIdeas()
    const legacyArchive = ideas.find(({ id }) => id === 'legacy-archive')
    const legacyActive = ideas.find(({ id }) => id === 'legacy-active')
    expect(legacyArchive?.archivedAt).toBe(10)
    expect(legacyActive?.archivedAt).toBeUndefined()
    for (const idea of ideas) {
      expect(idea.status === 'archived').toBe(idea.archivedAt !== undefined)
    }
  })

  it('applyIdeaTransfer persists transfer only on internal path', () => {
    const idea = createIdea({ title: 'Transfer me' })
    const transfer = ideaTransferSchema.parse({
      id: 'transfer-1',
      status: 'pending',
      profileId: 'prof-1',
      action: 'none',
      startedAt: Date.now(),
      updatedAt: Date.now()
    })
    const updated = applyIdeaTransfer(idea.id, transfer, { profileId: 'prof-1' })
    expect(updated.transfer?.id).toBe('transfer-1')
    expect(updated.refs?.profileId).toBe('prof-1')
    expect(ideaSchema.parse(updated).transfer?.status).toBe('pending')
    expect(updated.history?.at(-1)).toMatchObject({
      kind: 'transferStarted',
      detail: 'pending'
    })
  })

  it('records transfer updates and auto-archives a done status without losing links', () => {
    const idea = createIdea({
      title: 'Archive after transfer',
      refs: { workspaceId: 'workspace-1' }
    })
    const pending = ideaTransferSchema.parse({
      id: 'transfer-archive',
      status: 'pending',
      profileId: 'prof-1',
      action: 'none',
      startedAt: 10,
      updatedAt: 10
    })
    applyIdeaTransfer(idea.id, pending, {
      profileId: 'prof-1',
      workspaceId: 'workspace-1'
    })
    const running = ideaTransferSchema.parse({
      ...pending,
      status: 'running',
      updatedAt: 20,
      workspaceSessionId: 'session-1'
    })
    applyIdeaTransfer(idea.id, running, {
      profileId: 'prof-1',
      workspaceId: 'workspace-1'
    })

    const archived = updateIdea({ id: idea.id, status: 'done' })

    expect(archived.status).toBe('archived')
    expect(archived.archivedAt).toEqual(expect.any(Number))
    expect(archived.refs).toEqual({
      profileId: 'prof-1',
      workspaceId: 'workspace-1'
    })
    expect(archived.transfer).toEqual(running)
    expect(archived.history?.map(({ kind }) => kind)).toEqual([
      'created',
      'transferStarted',
      'transferUpdated',
      'statusChanged',
      'archived'
    ])
  })

  it('removes allowlisted attributes, restores archived ideas, and retains history', () => {
    const idea = createIdea({
      title: 'Restore me',
      tags: ['archive'],
      refs: { profileId: 'profile-1', workspaceId: 'workspace-1' }
    })
    const withoutWorkspace = removeIdeaAttribute(idea.id, 'workspaceId')
    expect(withoutWorkspace.refs).toEqual({ profileId: 'profile-1' })
    expect(withoutWorkspace.history?.at(-1)).toMatchObject({
      kind: 'attributeRemoved',
      detail: 'workspaceId'
    })

    updateIdea({ id: idea.id, status: 'done' })
    const restored = restoreIdea(idea.id)

    expect(restored.status).toBe('ready')
    expect(restored.archivedAt).toBeUndefined()
    expect(restored.history?.at(-1)?.kind).toBe('restored')
  })

  it('keeps timestamps and history unchanged for store-level attribute no-ops', () => {
    const idea = ideaSchema.parse({
      id: 'no-op',
      title: 'No-op',
      content: '',
      status: 'ready',
      tags: [],
      refs: { profileId: 'profile-1' },
      artifacts: [],
      history: [{ at: 1, kind: 'created' }],
      createdAt: 1,
      updatedAt: 100
    })
    __resetIdeasForTest([idea])

    const withoutTags = removeIdeaAttribute(idea.id, 'tags')
    const withoutWorkspace = removeIdeaAttribute(idea.id, 'workspaceId')

    for (const unchanged of [withoutTags, withoutWorkspace, getIdea(idea.id)]) {
      expect(unchanged?.updatedAt).toBe(100)
      expect(unchanged?.history).toEqual([{ at: 1, kind: 'created' }])
    }
  })

  it('lists ideas newest first via the shared archive sorter', () => {
    __resetIdeasForTest([
      ideaSchema.parse({
        id: 'old',
        title: 'Old',
        content: '',
        status: 'draft',
        tags: [],
        artifacts: [],
        createdAt: 1,
        updatedAt: 10
      }),
      ideaSchema.parse({
        id: 'new',
        title: 'New',
        content: '',
        status: 'ready',
        tags: [],
        artifacts: [],
        createdAt: 2,
        updatedAt: 20
      })
    ])

    expect(listIdeas().map(({ id }) => id)).toEqual(['new', 'old'])
  })

  it('resets transfer metadata so an idea can be handed over again', () => {
    const idea = createIdea({ title: 'Retry me' })
    const transfer = ideaTransferSchema.parse({
      id: 'transfer-2',
      status: 'failed',
      profileId: 'prof-2',
      workspaceSessionId: 'session-2',
      action: 'none',
      startedAt: Date.now(),
      updatedAt: Date.now()
    })
    applyIdeaTransfer(idea.id, transfer, {
      profileId: 'prof-2',
      workspaceId: 'session-2',
      planId: 'plan-2'
    })

    const reset = resetIdeaTransfer(idea.id)

    expect(reset.transfer).toBeUndefined()
    expect(reset.refs).toEqual({ profileId: 'prof-2' })
    expect(ideaSchema.parse(reset)).toEqual(reset)
  })
})

describe('inbox image artifacts', () => {
  beforeEach(() => {
    __resetIdeasForTest([])
  })

  it('stores a pasted image under a server-generated path and keeps the bytes', async () => {
    const idea = createIdea({ title: 'With screenshot' })
    const updated = await addArtifact(idea.id, {
      kind: 'image',
      dataBase64: TINY_PNG_BASE64,
      mimeType: 'image/png',
      name: 'shot.png'
    })

    const artifact = updated.artifacts.at(-1)
    expect(artifact?.kind).toBe('image')
    expect(artifact?.label).toBe('shot.png')
    expect(artifact?.mimeType).toBe('image/png')
    expect(artifact?.copied).toBe(true)
    // Filename is derived from the artifact id + validated extension — never from client input.
    expect(artifact?.storedPath).toMatch(new RegExp(`${artifact?.id}\\.png$`))
    expect(existsSync(artifact!.storedPath!)).toBe(true)
    expect(readFileSync(artifact!.storedPath!)).toEqual(Buffer.from(TINY_PNG_BASE64, 'base64'))
  })

  it('rejects unsupported image MIME types', async () => {
    const idea = createIdea({ title: 'Bad mime' })
    await expect(
      addArtifact(idea.id, {
        kind: 'image',
        dataBase64: TINY_PNG_BASE64,
        mimeType: 'image/svg+xml',
        name: 'x.svg'
      })
    ).rejects.toThrow(/Bildtyp/)
    expect(getIdea(idea.id)?.artifacts).toHaveLength(0)
  })

  it('rejects non-base64 payloads', async () => {
    const idea = createIdea({ title: 'Bad base64' })
    await expect(
      addArtifact(idea.id, {
        kind: 'image',
        dataBase64: 'not valid base64 @@@',
        mimeType: 'image/png'
      })
    ).rejects.toThrow(/Base64/)
    expect(getIdea(idea.id)?.artifacts).toHaveLength(0)
  })

  it('rejects images larger than the size cap', async () => {
    const idea = createIdea({ title: 'Too big' })
    const oversized = Buffer.alloc(MAX_IMAGE_ARTIFACT_BYTES + 1).toString('base64')
    await expect(
      addArtifact(idea.id, {
        kind: 'image',
        dataBase64: oversized,
        mimeType: 'image/png'
      })
    ).rejects.toThrow(/zu groß/)
    expect(getIdea(idea.id)?.artifacts).toHaveLength(0)
  })
})
