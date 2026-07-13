import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PROFILE } from '@shared/profile'

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  start: vi.fn(),
  ensure: vi.fn(),
  activate: vi.fn()
}))

vi.mock('@main/agents/AgentManager', () => ({
  agentManager: { spawn: mocks.spawn }
}))
vi.mock('@main/orchestrator/WorkspaceSessionRegistry', () => ({
  workspaceSessions: { start: mocks.start, ensure: mocks.ensure }
}))

import { spawnProfileTeam } from './spawnProfile'

describe('adaptive profile team start', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    const session = { id: 'session-1', engine: { activate: mocks.activate } }
    mocks.start.mockReturnValue(session)
    mocks.ensure.mockReturnValue(session)
    mocks.spawn.mockImplementation(async (request) => ({
      id: `agent-${mocks.spawn.mock.calls.length}`,
      name: request.kind === 'orchestrator' ? 'Gandalf' : 'Legolas',
      provider: request.provider,
      model: request.model,
      role: request.role,
      kind: request.kind ?? 'sub',
      mode: 'interactive',
      yolo: request.yolo,
      workingDir: request.workingDir ?? '.',
      status: 'running',
      startedAt: Date.now()
    }))
  })

  it('starts only the orchestrator and leaves unselected workers off in adaptive mode', async () => {
    const profile = {
      ...DEFAULT_PROFILE,
      planner: { ...DEFAULT_PROFILE.planner, routingMode: 'adaptive' as const }
    }

    const agents = await spawnProfileTeam(profile, false)

    expect(agents).toHaveLength(1)
    expect(mocks.spawn).toHaveBeenCalledTimes(1)
    expect(mocks.spawn).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'orchestrator',
      workspaceSessionId: 'session-1'
    }))
    expect(mocks.activate).toHaveBeenCalledWith(profile)
  })

  it('keeps the explicit prewarmed mode for profiles that want all slots immediately', async () => {
    const profile = {
      ...DEFAULT_PROFILE,
      planner: { ...DEFAULT_PROFILE.planner, routingMode: 'fixed' as const }
    }

    const agents = await spawnProfileTeam(profile, false)

    expect(agents).toHaveLength(4)
    expect(mocks.spawn).toHaveBeenCalledTimes(4)
    expect(mocks.spawn.mock.calls.filter(([request]) => request.kind !== 'orchestrator')).toHaveLength(3)
  })
})
