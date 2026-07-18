import { beforeEach, describe, expect, it } from 'vitest'
import { messagesForThread, useCanvasChatStore } from './canvasChatStore'

describe('canvasChatStore', () => {
  beforeEach(() => useCanvasChatStore.getState().clear())

  it('appends optimistic messages and records send failure', () => {
    const message = { id: 'one', profileId: 'p', workspaceSessionId: 's', text: 'Ziel', createdAt: 1, status: 'sending' as const }
    useCanvasChatStore.getState().append(message)
    useCanvasChatStore.getState().setStatus('one', 'failed')
    expect(useCanvasChatStore.getState().messages[0]?.status).toBe('failed')
  })

  it('does not leak messages across profiles or sessions', () => {
    const messages = [
      { id: 'one', profileId: 'p', workspaceSessionId: 's1', text: 'A', createdAt: 1, status: 'sent' as const },
      { id: 'two', profileId: 'p', workspaceSessionId: 's2', text: 'B', createdAt: 2, status: 'sent' as const },
      { id: 'three', profileId: 'q', workspaceSessionId: 's1', text: 'C', createdAt: 3, status: 'sent' as const }
    ]
    expect(messagesForThread(messages, 'p', 's1').map((message) => message.id)).toEqual(['one'])
  })
})
