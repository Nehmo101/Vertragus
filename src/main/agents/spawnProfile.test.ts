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
    const sessionFor = (profile = DEFAULT_PROFILE) => (
      { id: 'session-1', profile, engine: { activate: mocks.activate } }
    )
    mocks.start.mockImplementation(sessionFor)
    mocks.ensure.mockImplementation(sessionFor)
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

  it('creates the orchestrator first and survives a failing prewarmed worker in fixed mode', async () => {
    const profile = {
      ...DEFAULT_PROFILE,
      planner: { ...DEFAULT_PROFILE.planner, routingMode: 'fixed' as const }
    }

    let workerCalls = 0
    mocks.spawn.mockImplementation(async (request) => {
      if (request.kind !== 'orchestrator') {
        workerCalls += 1
        // The first prewarmed worker fails hard (e.g. provider gate reached).
        if (workerCalls === 1) throw new Error('Orca-Gate erreicht: codex')
      }
      return {
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
      }
    })

    const agents = await spawnProfileTeam(profile, false)

    // The orchestrator is spawned first and is always present, even though a
    // prewarmed worker failed afterwards — the whole team spawn does not abort.
    expect(mocks.spawn.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ kind: 'orchestrator' }))
    expect(agents[0]).toEqual(expect.objectContaining({ kind: 'orchestrator' }))
    expect(agents.filter((agent) => agent.kind === 'orchestrator')).toHaveLength(1)
    // Three codex workers configured; one failed → two survive, plus orchestrator.
    expect(agents).toHaveLength(3)
    expect(mocks.activate).toHaveBeenCalledWith(profile)
  })

  it('keeps global Yolo active for workers dispatched later by an adaptive session', async () => {
    const profile = {
      ...DEFAULT_PROFILE,
      planner: { ...DEFAULT_PROFILE.planner, routingMode: 'adaptive' as const }
    }

    await spawnProfileTeam(profile, true)

    expect(profile.yoloDefault).toBe(false)
    expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({ yoloDefault: true }))
    expect(mocks.spawn).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'orchestrator',
      yolo: true
    }))
    expect(mocks.activate).toHaveBeenCalledWith(expect.objectContaining({ yoloDefault: true }))
  })

  it('routes the team into the active-repo override instead of the profile default', async () => {
    const profile = {
      ...DEFAULT_PROFILE,
      workingDir: '/profile/repo',
      planner: { ...DEFAULT_PROFILE.planner, routingMode: 'fixed' as const }
    }

    await spawnProfileTeam(profile, false, { workingDirOverride: '/override/repo' })

    for (const [request] of mocks.spawn.mock.calls) {
      expect(request.workingDir).toBe('/override/repo')
    }
  })

  it('falls back to the profile default when no override is set', async () => {
    const profile = {
      ...DEFAULT_PROFILE,
      workingDir: '/profile/repo',
      planner: { ...DEFAULT_PROFILE.planner, routingMode: 'fixed' as const }
    }

    await spawnProfileTeam(profile, false, { workingDirOverride: '   ' })

    for (const [request] of mocks.spawn.mock.calls) {
      expect(request.workingDir).toBe('/profile/repo')
    }
  })
})
