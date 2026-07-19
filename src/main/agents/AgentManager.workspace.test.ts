import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '.' }
}))
vi.mock('@main/windows', () => ({
  closePaneWindows: vi.fn()
}))
vi.mock('@main/config/store', () => ({
  getSetting: () => undefined,
  listMcpServers: () => []
}))
const taskResult = vi.hoisted(() => ({
  status: 'succeeded' as 'succeeded' | 'failed',
  isError: false
}))
const rollbackWorktreeMock = vi.hoisted(() => vi.fn().mockResolvedValue(true))
vi.mock('@main/agents/worktree', () => ({
  createWorktree: vi.fn().mockResolvedValue(undefined),
  rollbackWorktree: rollbackWorktreeMock
}))
vi.mock('@main/agents/headless', () => ({
  runHeadless: vi.fn((...args: unknown[]) => {
    const onData = args[3] as (chunk: string) => void
    onData('retained terminal output')
    return {
      pid: 123,
      kill: vi.fn(),
      done: Promise.resolve({
        result: 'done',
        status: taskResult.status,
        isError: taskResult.isError
      })
    }
  })
}))


import type { AgentInstanceInfo } from '@shared/agents'
import { AgentManager, type PanePreflightRunner } from '@main/agents/AgentManager'

const successfulPreflight: PanePreflightRunner = async (input) => {
  const now = Date.now()
  return {
    status: 'passed',
    provider: input.provider,
    workspaceId: input.workingDir,
    engineId: input.engineId,
    workspaceSessionId: input.workspaceSessionId,
    startedAt: now,
    completedAt: now,
    checks: []
  }
}

function info(id: string, profileId: string): AgentInstanceInfo {
  return {
    id,
    profileId,
    workspaceSessionId: `session-${profileId}`,
    name: id,
    provider: 'codex',
    model: '',
    role: 'Subagent',
    kind: 'sub',
    mode: 'interactive',
    yolo: false,
    workingDir: '.',
    status: 'running',
    startedAt: Date.now()
  }
}

function add(
  manager: AgentManager,
  agent: AgentInstanceInfo,
  process?: { kill(): void },
  buffer = ''
): void {
  const records = (manager as unknown as { agents: Map<string, unknown> }).agents
  records.set(agent.id, {
    info: agent,
    pty: process,
    buffer,
    seq: 0
  })
}

describe('AgentManager workspace isolation', () => {
  it('lists and detects running agents per profile', () => {
    const manager = new AgentManager()
    add(manager, info('alpha-agent', 'alpha'), { kill: vi.fn() })
    add(manager, info('beta-agent', 'beta'), { kill: vi.fn() })

    expect(manager.list('alpha').map((agent) => agent.id)).toEqual(['alpha-agent'])
    expect(manager.list('beta').map((agent) => agent.id)).toEqual(['beta-agent'])
    expect(manager.anyRunning('alpha')).toBe(true)
    expect(manager.anyRunning('missing')).toBe(false)
  })

  it('stops only the requested workspace', async () => {
    const manager = new AgentManager()
    const alphaKill = vi.fn()
    const betaKill = vi.fn()
    add(manager, info('alpha-agent', 'alpha'), { kill: alphaKill })
    add(manager, info('beta-agent', 'beta'), { kill: betaKill })

    await manager.killAll('alpha')

    expect(alphaKill).toHaveBeenCalledOnce()
    expect(betaKill).not.toHaveBeenCalled()
    expect(manager.list('alpha')[0]?.status).toBe('stopped')
    expect(manager.anyRunning('beta')).toBe(true)
  })

  it('removes panes only from the requested workspace', async () => {
    const manager = new AgentManager()
    add(manager, { ...info('alpha-agent', 'alpha'), status: 'stopped' })
    add(manager, { ...info('beta-agent', 'beta'), status: 'stopped' })

    await manager.removeAll('alpha')

    expect(manager.list().map((agent) => agent.id)).toEqual(['beta-agent'])
  })

  it('rolls back the isolated worktree of every removed agent', async () => {
    rollbackWorktreeMock.mockClear()
    const manager = new AgentManager()
    add(manager, {
      ...info('alpha-agent', 'alpha'),
      status: 'stopped',
      worktree: '/repo/.orca-worktrees/session-alpha/alpha-agent',
      branch: 'orca/session-alpha/alpha-agent'
    })
    // A pane without an isolated worktree must not trigger a rollback.
    add(manager, { ...info('plain-agent', 'alpha'), status: 'stopped' })

    await manager.removeAll('alpha')

    expect(rollbackWorktreeMock).toHaveBeenCalledTimes(1)
    expect(rollbackWorktreeMock).toHaveBeenCalledWith(
      '/repo/.orca-worktrees/session-alpha/alpha-agent',
      'orca/session-alpha/alpha-agent'
    )
    expect(manager.list('alpha')).toEqual([])
  })

  it('keeps removing agents even when a worktree rollback fails', async () => {
    rollbackWorktreeMock.mockClear()
    rollbackWorktreeMock.mockRejectedValueOnce(new Error('git busy'))
    const manager = new AgentManager()
    add(manager, {
      ...info('alpha-agent', 'alpha'),
      status: 'stopped',
      worktree: '/repo/.orca-worktrees/session-alpha/alpha-agent',
      branch: 'orca/session-alpha/alpha-agent'
    })

    await expect(manager.removeAll('alpha')).resolves.toBeUndefined()
    expect(manager.list('alpha')).toEqual([])
  })

  it('persists resume states grouped per workspace session, skipping unbound panes', () => {
    const manager = new AgentManager()
    add(manager, info('alpha-agent', 'alpha'), undefined, 'alpha terminal output')
    add(manager, info('beta-agent', 'beta'))
    add(manager, { ...info('login-pane', 'alpha'), workspaceSessionId: undefined })

    const writes = new Map<string, unknown[]>()
    manager.persistResumeStates({
      writeAgentResumeStates: (sessionId, agents) => writes.set(sessionId, agents)
    })

    expect([...writes.keys()].sort()).toEqual(['session-alpha', 'session-beta'])
    expect(writes.get('session-alpha')).toEqual([
      expect.objectContaining({
        info: expect.objectContaining({ id: 'alpha-agent' }),
        scrollbackTail: 'alpha terminal output'
      })
    ])
  })

  it.each([
    ['succeeded', false, 'stopped'],
    ['failed', true, 'error']
  ] as const)('retains %s task chats until the workspace is cleared', async (status, isError, expected) => {
    taskResult.status = status
    taskResult.isError = isError
    const manager = new AgentManager(successfulPreflight)
    const run = await manager.runTask({
      provider: 'codex',
      model: '',
      role: 'Backend',
      taskId: `task-${status}`,
      prompt: 'Do the work',
      yolo: false,
      workingDir: '.',
      profileId: 'alpha',
      workspaceSessionId: 'session-alpha'
    })

    await run.done
    expect(manager.list('alpha')).toEqual([expect.objectContaining({ id: run.info.id, status: expected })])
    expect(manager.buffer(run.info.id).data).toContain('retained terminal output')

    await manager.removeAll('alpha')
    expect(manager.list('alpha')).toEqual([])
  })
})
