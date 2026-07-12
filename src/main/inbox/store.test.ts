import { describe, expect, it, vi, beforeEach } from 'vitest'
import { ideaSchema } from '@shared/inbox'
import { ideaTransferSchema } from '@shared/inboxTransfer'
import {
  __resetIdeasForTest,
  applyIdeaTransfer,
  createIdea,
  updateIdea
} from './store'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/orca-test-userdata' }
}))

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
  })
})
