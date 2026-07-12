import { describe, expect, it, vi } from 'vitest'

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
  process?: { kill(): void }
): void {
  const records = (manager as unknown as { agents: Map<string, unknown> }).agents
  records.set(agent.id, {
    info: agent,
    pty: process,
    buffer: '',
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
})
