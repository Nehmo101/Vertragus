import { beforeEach, describe, expect, it, vi } from 'vitest'

const ptyMock = vi.hoisted(() => ({
  spawn: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: () => '.' }
}))
vi.mock('@lydell/node-pty', () => ptyMock)
vi.mock('@main/windows', () => ({
  closePaneWindows: vi.fn()
}))
vi.mock('@main/config/store', () => ({
  getSetting: () => undefined
}))
vi.mock('@main/agents/resolveCommand', () => ({
  resolveLaunch: vi.fn(async (command: string, args: string[]) => ({ file: command, args }))
}))

import { AgentManager } from '@main/agents/AgentManager'
import { closePaneWindows } from '@main/windows'

type ExitHandler = (event: { exitCode: number; signal?: number }) => void

describe('AgentManager provider login cleanup', () => {
  let exitHandler: ExitHandler | undefined

  beforeEach(() => {
    exitHandler = undefined
    ptyMock.spawn.mockReset()
    vi.mocked(closePaneWindows).mockReset()
    ptyMock.spawn.mockReturnValue({
      pid: 123,
      onData: vi.fn(),
      onExit: vi.fn((handler: ExitHandler) => {
        exitHandler = handler
      }),
      kill: vi.fn(),
      resize: vi.fn(),
      write: vi.fn()
    })
  })

  it('closes and removes a successful login terminal', async () => {
    const manager = new AgentManager()
    const completed = vi.fn()
    manager.on('provider-auth-complete', completed)

    const login = await manager.loginProvider('claude')
    exitHandler?.({ exitCode: 0 })

    expect(completed).toHaveBeenCalledWith('claude')
    expect(closePaneWindows).toHaveBeenCalledWith(login.id)
    expect(manager.list()).toEqual([])
  })

  it('keeps a failed login terminal open for diagnostics', async () => {
    const manager = new AgentManager()

    const login = await manager.loginProvider('claude')
    exitHandler?.({ exitCode: 1 })

    expect(closePaneWindows).not.toHaveBeenCalled()
    expect(manager.list()).toEqual([
      expect.objectContaining({ id: login.id, status: 'error', exitCode: 1 })
    ])
  })
})
