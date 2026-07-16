import { describe, expect, it, vi } from 'vitest'
import type { Idea } from '@shared/inbox'
import {
  assertAuthorizedInboxArchiveSender,
  createInboxArchiveIpcController,
  type ArchiveIpcEventLike
} from './archiveIpc'

const idea: Idea = {
  id: 'idea-1',
  title: 'Idee',
  content: '',
  status: 'ready',
  tags: [],
  artifacts: [],
  createdAt: 1,
  updatedAt: 1
}

function event(senderId = 1, url = 'app://renderer'): ArchiveIpcEventLike {
  const mainFrame = { url }
  return {
    sender: {
      id: senderId,
      isDestroyed: () => false,
      getURL: () => url,
      mainFrame
    },
    senderFrame: mainFrame
  }
}

describe('inbox archive IPC controller', () => {
  it('rejects a foreign renderer origin even for a known window', () => {
    expect(() => assertAuthorizedInboxArchiveSender(event(1, 'https://evil.example'), {
      developmentUrl: 'http://localhost:5173',
      packagedRendererUrl: 'file:///opt/orca/renderer/index.html',
      isKnownSender: () => true
    })).toThrow(/unauthorized/)
  })

  it('rejects a foreign origin without exposing the configured renderer URL', () => {
    const developmentUrl = 'http://localhost:5173'
    let message = ''
    try {
      assertAuthorizedInboxArchiveSender(event(1, 'https://evil.example'), {
        developmentUrl,
        packagedRendererUrl: 'file:///opt/orca/renderer/index.html',
        isKnownSender: () => true
      })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    expect(message).toMatch(/unauthorized/)
    expect(message).not.toContain(developmentUrl)
  })

  it('rejects unauthorized callers before invoking the store', () => {
    const removeAttribute = vi.fn(() => idea)
    const restoreIdea = vi.fn(() => idea)
    const controller = createInboxArchiveIpcController({
      authorize: () => {
        throw new Error('unauthorized')
      },
      removeAttribute,
      restoreIdea
    })

    expect(() => controller.removeAttribute(event(99), 'idea-1', 'tags')).toThrow(
      /unauthorized/
    )
    expect(removeAttribute).not.toHaveBeenCalled()
    expect(restoreIdea).not.toHaveBeenCalled()
  })

  it('rejects non-string ids and attributes outside the allowlist', () => {
    const removeAttribute = vi.fn(() => idea)
    const restoreIdea = vi.fn(() => idea)
    const controller = createInboxArchiveIpcController({
      authorize: vi.fn(),
      removeAttribute,
      restoreIdea
    })

    expect(() => controller.removeAttribute(event(), { id: 'idea-1' }, 'tags')).toThrow(
      /Ungültige Anfrage/
    )
    expect(() => controller.removeAttribute(event(), 'idea-1', 'transfer')).toThrow(
      /Ungültige Anfrage/
    )
    expect(() => controller.restoreIdea(event(), { id: 'idea-1' })).toThrow(
      /Ungültige Anfrage/
    )
    expect(removeAttribute).not.toHaveBeenCalled()
    expect(restoreIdea).not.toHaveBeenCalled()
  })

  it('passes only validated scalar inputs to store operations', () => {
    const removeAttribute = vi.fn(() => idea)
    const restoreIdea = vi.fn(() => idea)
    const controller = createInboxArchiveIpcController({
      authorize: vi.fn(),
      removeAttribute,
      restoreIdea
    })

    expect(controller.removeAttribute(event(), 'idea-1', 'workspaceId')).toBe(idea)
    expect(controller.restoreIdea(event(), 'idea-1')).toBe(idea)
    expect(removeAttribute).toHaveBeenCalledWith('idea-1', 'workspaceId')
    expect(restoreIdea).toHaveBeenCalledWith('idea-1')
  })
})
