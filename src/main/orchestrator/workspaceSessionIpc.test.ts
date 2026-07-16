import { describe, expect, it, vi } from 'vitest'
import type {
  RendererIpcEventLike,
  RendererIpcWebContentsLike
} from '@main/security/ipcAuthorization'
import {
  createWorkspaceSessionIpcController,
  type WorkspaceSessionIpcDependencies
} from './workspaceSessionIpc'

function event(id = 7, url = 'http://localhost:5173/#/'): RendererIpcEventLike {
  const frame = { url }
  const sender: RendererIpcWebContentsLike = {
    id,
    isDestroyed: () => false,
    getURL: () => url,
    mainFrame: frame
  }
  return { sender, senderFrame: frame }
}

function dependencies(): WorkspaceSessionIpcDependencies {
  return {
    authorization: {
      developmentUrl: 'http://localhost:5173',
      packagedRendererUrl: 'file:///app/renderer/index.html',
      isKnownSender: (sender) => sender.id === 7
    },
    list: vi.fn(() => []),
    setActive: vi.fn((profileId, sessionId) => ({
      profileId,
      workspaceSessionId: sessionId,
      goal: null,
      tasks: []
    })),
    remove: vi.fn(async () => [])
  }
}

describe('workspace session IPC authorization', () => {
  it('allows an authorized list request', () => {
    const deps = dependencies()
    const controller = createWorkspaceSessionIpcController(deps)

    expect(controller.list(event(), 'alpha')).toEqual([])
    expect(deps.list).toHaveBeenCalledWith('alpha')
  })

  it('rejects unauthorized callers before reading or mutating workspace state', async () => {
    const deps = dependencies()
    const controller = createWorkspaceSessionIpcController(deps)

    expect(() => controller.list(event(8), 'alpha')).toThrow(/unauthorized/i)
    expect(() => controller.setActive(event(8), 'alpha', 'session-alpha')).toThrow(/unauthorized/i)
    await expect(controller.remove(event(8), 'alpha', 'session-alpha')).rejects.toThrow(/unauthorized/i)
    expect(deps.list).not.toHaveBeenCalled()
    expect(deps.setActive).not.toHaveBeenCalled()
    expect(deps.remove).not.toHaveBeenCalled()
  })

  it('rejects invalid identifiers before reading or mutating workspace state', async () => {
    const deps = dependencies()
    const controller = createWorkspaceSessionIpcController(deps)

    expect(() => controller.list(event(), null)).toThrow(/invalid payload/i)
    expect(() => controller.setActive(event(), '', 'session-alpha')).toThrow(/invalid payload/i)
    await expect(controller.remove(event(), 'alpha', ' '.repeat(2))).rejects.toThrow(/invalid payload/i)
    expect(deps.list).not.toHaveBeenCalled()
    expect(deps.setActive).not.toHaveBeenCalled()
    expect(deps.remove).not.toHaveBeenCalled()
  })

  it('rejects foreign origins without leaking renderer context or workspace identifiers', () => {
    const controller = createWorkspaceSessionIpcController(dependencies())
    let rejection: unknown

    try {
      controller.setActive(
        event(7, 'https://attacker.example/private'),
        'sensitive-profile',
        'sensitive-session'
      )
    } catch (error) {
      rejection = error
    }

    expect(rejection).toBeInstanceOf(Error)
    expect((rejection as Error).message).not.toContain('attacker.example')
    expect((rejection as Error).message).not.toContain('sensitive-profile')
    expect((rejection as Error).message).not.toContain('sensitive-session')
  })
})
