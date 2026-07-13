import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '.' }
}))
vi.mock('@main/windows', () => ({
  closePaneWindows: vi.fn()
}))
vi.mock('@main/config/store', () => ({
  getSetting: () => undefined
}))

import type { AgentInstanceInfo } from '@shared/agents'
import { AgentManager } from '@main/agents/AgentManager'

const worktree = 'C:\\git\\UWE\\.orca-worktrees\\session-a\\sub-01'

function addCursorAgent(manager: AgentManager): {
  write: ReturnType<typeof vi.fn>
  kill: ReturnType<typeof vi.fn>
  managed: unknown
} {
  const write = vi.fn()
  const kill = vi.fn()
  const info: AgentInstanceInfo = {
    id: 'sub-01',
    name: 'Glaurung',
    provider: 'cursor',
    model: 'composer',
    role: 'Subagent',
    kind: 'sub',
    mode: 'interactive',
    yolo: false,
    workingDir: worktree,
    worktree,
    status: 'running',
    startedAt: 1
  }
  const managed = { info, pty: { write, kill }, buffer: '', seq: 0 }
  const agents = (manager as unknown as { agents: Map<string, unknown> }).agents
  agents.set(info.id, managed)
  return { write, kill, managed }
}

function push(manager: AgentManager, managed: unknown, output: string): void {
  ;(manager as unknown as { pushData(agent: unknown, data: string): void }).pushData(managed, output)
}

afterEach(() => vi.useRealTimers())

describe('AgentManager Cursor workspace trust dispatch', () => {
  it('retries an incomplete PTY prompt and sends a exactly once with a dispatch event', () => {
    vi.useFakeTimers()
    const manager = new AgentManager()
    const event = vi.fn()
    manager.on('event', event)
    const { write, managed } = addCursorAgent(manager)

    push(manager, managed, 'Workspace Trust Required\nTrust this workspace')
    vi.advanceTimersByTime(150)
    expect(write).not.toHaveBeenCalled()

    push(manager, managed, `\n${worktree}\n(A) Trust this workspace`)
    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith('a\r')
    expect(event).toHaveBeenCalledWith(
      expect.objectContaining({ tone: 'dispatch', text: expect.stringContaining('a gesendet') })
    )

    push(manager, managed, '\n[a] Trust this workspace')
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('cancels a pending retry when the user has interacted with the terminal', () => {
    vi.useFakeTimers()
    const manager = new AgentManager()
    const { write, managed } = addCursorAgent(manager)

    push(manager, managed, 'Trust this workspace')
    manager.markInteractiveUsed('sub-01')
    push(manager, managed, `\n${worktree}\n[a] Trust this workspace`)
    vi.advanceTimersByTime(500)

    expect(write).not.toHaveBeenCalled()
  })

  it('nudges Cursor once and terminates a trust confirmation that remains stuck', () => {
    vi.useFakeTimers()
    const manager = new AgentManager()
    const event = vi.fn()
    manager.on('event', event)
    const { write, kill, managed } = addCursorAgent(manager)

    push(manager, managed, `${worktree}\n[a] Trust this workspace`)
    expect(write).toHaveBeenCalledWith('a\r')

    push(manager, managed, '\nTrusting workspace...')
    vi.advanceTimersByTime(8_000)
    expect(write).toHaveBeenLastCalledWith('\r')
    expect(kill).not.toHaveBeenCalled()

    vi.advanceTimersByTime(8_000)
    expect(kill).toHaveBeenCalledTimes(1)
    expect(manager.list()).toEqual([expect.objectContaining({ id: 'sub-01', status: 'error' })])
    expect(event).toHaveBeenCalledWith(
      expect.objectContaining({ tone: 'error', text: expect.stringContaining('Workspace-Trust fehlgeschlagen') })
    )
  })
})
