import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentResumeState } from '@shared/agents'

const store = vi.hoisted(() => ({
  consumeCleanShutdownFlag: vi.fn(() => false),
  markCleanShutdown: vi.fn(),
  listSessions: vi.fn(() => [] as unknown[]),
  readAgentResumeStates: vi.fn(() => [] as unknown[])
}))
const registry = vi.hoisted(() => ({
  rehydrate: vi.fn(() => 2),
  flushSnapshots: vi.fn(),
  list: vi.fn(() => [] as unknown[]),
  getById: vi.fn(() => undefined as unknown)
}))
const agents = vi.hoisted(() => ({
  startResumeStateSweep: vi.fn(),
  persistResumeStates: vi.fn(),
  hasAliveSessionAgents: vi.fn((_id: string) => false),
  respawnSessionAgents: vi.fn(async () => [] as unknown[])
}))
const worktree = vi.hoisted(() => ({
  inventoryWorktrees: vi.fn(async () => [] as unknown[]),
  currentBranch: vi.fn(async () => 'vertragus/session-gone/codex-01'),
  rollbackWorktree: vi.fn(async () => true)
}))
const migrate = vi.hoisted(() => vi.fn(() => 0))

vi.mock('@main/config/store', () => ({
  getProfile: vi.fn(),
  getSetting: vi.fn(() => undefined),
  listProfiles: vi.fn(() => [{ id: 'default', workingDir: '/repo' }])
}))
vi.mock('@main/config/sessionStore', () => ({
  sessionStore: store,
  migrateLegacySettingsSnapshots: migrate
}))
vi.mock('@main/orchestrator/WorkspaceSessionRegistry', () => ({
  workspaceSessions: registry
}))
vi.mock('@main/agents/AgentManager', () => ({ agentManager: agents }))
vi.mock('@main/agents/worktree', () => ({
  inventoryWorktrees: worktree.inventoryWorktrees,
  currentBranch: worktree.currentBranch,
  rollbackWorktree: worktree.rollbackWorktree,
  isOrcaBranch: (branch: string) => /^(?:vertragus|orca)\//.test(branch),
  isOrcaWorktreePath: (path: string) => /[\\/]\.(?:vertragus|orca)-worktrees[\\/]/.test(path),
  worktreeSessionDirName: (id: string) => id.toLowerCase()
}))
vi.mock('@shared/profile', () => ({ profileRepoLocalPath: () => undefined }))

import {
  discardOrphanWorktree,
  discardOrphanWorktrees,
  finalizeSessionPersistence,
  getRestoreStatus,
  lastShutdownWasClean,
  prepareSessionPersistence,
  restartSessionAgents
} from './sessionRestore'

function resumeState(mode: 'interactive' | 'task', capturedAt = 10): AgentResumeState {
  return {
    info: { id: 'a', mode, provider: 'codex' },
    scrollbackTail: '',
    capturedAt
  } as unknown as AgentResumeState
}

beforeEach(() => {
  vi.clearAllMocks()
  store.listSessions.mockReturnValue([])
  registry.list.mockReturnValue([])
})

describe('sessionRestore', () => {
  it('migrates, arms the crash marker, rehydrates and starts the sweep on startup', () => {
    store.consumeCleanShutdownFlag.mockReturnValueOnce(false)
    const result = prepareSessionPersistence()

    expect(migrate).toHaveBeenCalledOnce()
    expect(store.consumeCleanShutdownFlag).toHaveBeenCalledOnce()
    expect(registry.rehydrate).toHaveBeenCalledOnce()
    // Migration must run before the rehydrate pass reads the index.
    expect(migrate.mock.invocationCallOrder[0]!).toBeLessThan(
      registry.rehydrate.mock.invocationCallOrder[0]!
    )
    expect(result).toEqual({ cleanShutdown: false, restoredSessions: 2 })
    expect(lastShutdownWasClean()).toBe(false)
    expect(agents.startResumeStateSweep).toHaveBeenCalledOnce()
  })

  it('persists agent states and flushes every engine before marking the shutdown clean', () => {
    finalizeSessionPersistence()

    expect(agents.persistResumeStates).toHaveBeenCalledOnce()
    expect(registry.flushSnapshots).toHaveBeenCalledOnce()
    expect(store.markCleanShutdown).toHaveBeenCalledOnce()
    expect(agents.persistResumeStates.mock.invocationCallOrder[0]!).toBeLessThan(
      store.markCleanShutdown.mock.invocationCallOrder[0]!
    )
    expect(registry.flushSnapshots.mock.invocationCallOrder[0]!).toBeLessThan(
      store.markCleanShutdown.mock.invocationCallOrder[0]!
    )
  })

  it('aggregates resumable sessions, orphaned worktrees and stale sessions', async () => {
    const now = Date.now()
    store.listSessions.mockReturnValue([
      { id: 'fresh', profileId: 'default', name: 'Purgatorio', updatedAt: now },
      { id: 'old', profileId: 'default', name: 'Limbo', updatedAt: now - 45 * 86_400_000 }
    ])
    registry.list.mockReturnValue([
      { id: 'fresh', profileId: 'default', name: 'Purgatorio' },
      { id: 'busy', profileId: 'default', name: 'Inferno' }
    ])
    agents.hasAliveSessionAgents.mockImplementation((id: string) => id === 'busy')
    store.readAgentResumeStates.mockReturnValue([
      resumeState('interactive', 5),
      resumeState('interactive', 9),
      resumeState('task')
    ])
    worktree.inventoryWorktrees.mockResolvedValue([
      { path: '/repo/.vertragus-worktrees/fresh/sub-01', sessionId: 'fresh', agentId: 'sub-01', legacy: false, owned: true, changedFiles: 0 },
      { path: '/repo/.vertragus-worktrees/gone/sub-01', sessionId: 'gone', agentId: 'sub-01', legacy: false, owned: false, changedFiles: 2 }
    ])

    const status = await getRestoreStatus()

    expect(status.resumableSessions).toEqual([
      expect.objectContaining({ id: 'fresh', agentCount: 2, capturedAt: 9 })
    ])
    expect(status.orphanedWorktrees).toEqual([
      expect.objectContaining({ sessionId: 'gone', changedFiles: 2 })
    ])
    expect(status.staleSessions).toEqual([expect.objectContaining({ id: 'old' })])
  })

  it('restarts a session team and activates the engine when an orchestrator returned', async () => {
    const activate = vi.fn()
    registry.getById.mockReturnValue({
      id: 's1',
      profileId: 'default',
      profile: { id: 'default' },
      engine: { engineId: 'engine-s1', activate }
    })
    store.readAgentResumeStates.mockReturnValue([resumeState('interactive')])
    agents.respawnSessionAgents.mockResolvedValue([{ kind: 'orchestrator' }])

    const spawned = await restartSessionAgents('default', 's1')

    expect(agents.respawnSessionAgents).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: 'default', workspaceSessionId: 's1', engineId: 'engine-s1' })
    )
    expect(activate).toHaveBeenCalledOnce()
    expect(spawned).toHaveLength(1)
  })

  it('refuses to restart an unknown session or one without saved states', async () => {
    registry.getById.mockReturnValue(undefined)
    await expect(restartSessionAgents('default', 'missing')).rejects.toThrow('nicht gefunden')

    registry.getById.mockReturnValue({
      id: 's1', profileId: 'default', profile: {}, engine: { engineId: 'e', activate: vi.fn() }
    })
    store.readAgentResumeStates.mockReturnValue([])
    await expect(restartSessionAgents('default', 's1')).rejects.toThrow('keine gesicherten')
  })

  it('discards only unmanaged orphan worktrees and passes the managed branch', async () => {
    await expect(discardOrphanWorktree('/repo/src')).rejects.toThrow('kein Vertragus-Worktree')

    store.listSessions.mockReturnValue([{ id: 'kept', profileId: 'default', name: '', updatedAt: 1 }])
    await expect(
      discardOrphanWorktree('/repo/.vertragus-worktrees/kept/sub-01')
    ).rejects.toThrow('bekannten Session')

    await expect(
      discardOrphanWorktree('/repo/.vertragus-worktrees/session-gone/codex-01')
    ).resolves.toBe(true)
    expect(worktree.rollbackWorktree).toHaveBeenCalledWith(
      '/repo/.vertragus-worktrees/session-gone/codex-01',
      'vertragus/session-gone/codex-01'
    )
  })

  it('discards many orphan worktrees and reports per-path failures', async () => {
    store.listSessions.mockReturnValue([])
    worktree.rollbackWorktree
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error('boom'))

    await expect(
      discardOrphanWorktrees([
        '/repo/.vertragus-worktrees/gone-a/task-01',
        '/repo/.vertragus-worktrees/gone-b/task-02',
        '/repo/src',
        '/repo/.vertragus-worktrees/gone-a/task-01'
      ])
    ).resolves.toEqual({ discarded: 1, failed: 2 })
  })
})
