import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '.', getName: () => 'test', isPackaged: false }
}))
vi.mock('@main/windows', () => ({ closePaneWindows: vi.fn() }))
vi.mock('@main/config/store', () => ({
  getSetting: () => undefined,
  getProfile: () => undefined,
  listMcpServers: () => []
}))
vi.mock('@main/agents/worktree', () => ({
  createWorktree: vi.fn().mockResolvedValue(undefined),
  rollbackWorktree: vi.fn(),
  isOrcaBranch: (branch: string) => /^(?:vertragus|orca)\//.test(branch)
}))
const fsMocks = vi.hoisted(() => ({ existing: new Set<string>() }))
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  existsSync: (path: unknown) => fsMocks.existing.has(String(path)),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn()
}))

import type { AgentInstanceInfo, AgentResumeState } from '@shared/agents'
import { AgentManager } from '@main/agents/AgentManager'

function state(overrides: Partial<AgentInstanceInfo>): AgentResumeState {
  return {
    info: {
      id: 'old-01',
      name: 'Virgilio',
      provider: 'codex',
      model: '',
      role: 'Subagent · Backend',
      kind: 'sub',
      mode: 'interactive',
      yolo: false,
      workingDir: '/repo',
      status: 'running',
      startedAt: 1,
      workspaceSessionId: 'session-1',
      ...overrides
    } as AgentInstanceInfo,
    scrollbackTail: 'letzter Stand',
    capturedAt: 10
  }
}

function setup(): {
  manager: AgentManager
  spawn: ReturnType<typeof vi.fn>
  seed: ReturnType<typeof vi.fn>
} {
  const manager = new AgentManager()
  let seq = 0
  const spawn = vi.fn(async (req: Record<string, unknown>) => {
    seq += 1
    return {
      id: `new-${seq}`,
      name: `Agent ${seq}`,
      provider: req.provider,
      model: '',
      role: req.role,
      kind: req.kind ?? 'sub',
      mode: 'interactive',
      yolo: false,
      workingDir: req.workingDir,
      status: 'running',
      startedAt: Date.now()
    } as AgentInstanceInfo
  })
  const seed = vi.fn(async () => true)
  Object.assign(manager, { spawn, seedInteractive: seed })
  return { manager, spawn, seed }
}

describe('AgentManager.respawnSessionAgents', () => {
  it('restarts the orchestrator first and seeds briefings where no native resume exists', async () => {
    fsMocks.existing.clear()
    fsMocks.existing.add('/repo/.vertragus-worktrees/session-1/sub-01')
    const { manager, spawn, seed } = setup()

    const spawned = await manager.respawnSessionAgents({
      profileId: 'default',
      workspaceSessionId: 'session-1',
      engineId: 'engine-session-1',
      states: [
        state({
          id: 'old-sub',
          kind: 'sub',
          provider: 'codex',
          worktree: '/repo/.vertragus-worktrees/session-1/sub-01'
        }),
        state({ id: 'old-orch', kind: 'orchestrator', provider: 'codex' }),
        // Task workers are continued via resumeInterruptedTask, never respawned here.
        state({ id: 'old-task', mode: 'task' })
      ]
    })

    expect(spawned).toHaveLength(2)
    expect(spawn.mock.calls[0]![0]).toMatchObject({ kind: 'orchestrator' })
    expect(spawn.mock.calls[1]![0]).toMatchObject({
      kind: 'sub',
      workingDir: '/repo/.vertragus-worktrees/session-1/sub-01',
      isolateWorktree: false,
      resumeConversation: false
    })
    // codex has no safe cwd-scoped resume → both agents get a briefing seed.
    expect(seed).toHaveBeenCalledTimes(2)
    expect(String(seed.mock.calls[0]![1])).toContain('neu gestartet')
  })

  it('uses native conversation resume for claude in a preserved directory and skips the seed', async () => {
    fsMocks.existing.clear()
    fsMocks.existing.add('/repo/.vertragus-worktrees/session-1/claude-01')
    const { manager, spawn, seed } = setup()

    const spawned = await manager.respawnSessionAgents({
      profileId: 'default',
      workspaceSessionId: 'session-1',
      states: [
        state({
          provider: 'claude',
          worktree: '/repo/.vertragus-worktrees/session-1/claude-01'
        })
      ]
    })

    expect(spawned).toHaveLength(1)
    expect(spawn.mock.calls[0]![0]).toMatchObject({
      provider: 'claude',
      resumeConversation: true,
      isolateWorktree: false
    })
    expect(seed).not.toHaveBeenCalled()
  })

  it('refuses to respawn while the session still has live agents', async () => {
    const { manager } = setup()
    const records = (manager as unknown as { agents: Map<string, unknown> }).agents
    records.set('alive', {
      info: { id: 'alive', workspaceSessionId: 'session-1', status: 'running' },
      pty: { kill: vi.fn() },
      buffer: '',
      seq: 0
    })

    await expect(
      manager.respawnSessionAgents({
        profileId: 'default',
        workspaceSessionId: 'session-1',
        states: [state({})]
      })
    ).rejects.toThrow('bereits laufende Agenten')
  })

  it('continues the remaining team when one slot fails to spawn', async () => {
    fsMocks.existing.clear()
    const { manager, spawn } = setup()
    spawn.mockRejectedValueOnce(new Error('CLI fehlt'))

    const spawned = await manager.respawnSessionAgents({
      profileId: 'default',
      workspaceSessionId: 'session-1',
      states: [state({ id: 'broken' }), state({ id: 'fine' })]
    })

    expect(spawn).toHaveBeenCalledTimes(2)
    expect(spawned).toHaveLength(1)
  })
})
