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

function trackedTask(): AgentInstanceInfo {
  return {
    id: 'task-01',
    name: 'Boromir',
    provider: 'claude',
    model: 'sonnet',
    role: 'Task · worker',
    kind: 'sub',
    mode: 'task',
    yolo: false,
    workingDir: '.',
    status: 'running',
    startedAt: 1
  }
}

type WithLiveUsage = {
  agents: Map<string, { info: AgentInstanceInfo; buffer: string; seq: number }>
  applyLiveUsage(id: string, snapshot: Record<string, number | undefined>): void
}

describe('AgentManager live telemetry', () => {
  it('folds a streamed usage snapshot into the running agent and notifies listeners', () => {
    const manager = new AgentManager()
    const info = trackedTask()
    const internal = manager as unknown as WithLiveUsage
    internal.agents.set(info.id, { info, buffer: '', seq: 0 })

    const changed = vi.fn()
    manager.on('changed', changed)

    internal.applyLiveUsage(info.id, { costUsd: 0.02, tokensIn: 12, tokensOut: 8, steps: 3 })

    // The tracked info is mutated in place so the still-running pane fills in.
    expect(info.usage).toEqual({ costUsd: 0.02, tokensIn: 12, tokensOut: 8, steps: 3 })
    expect(changed).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          id: info.id,
          usage: { costUsd: 0.02, tokensIn: 12, tokensOut: 8, steps: 3 }
        })
      ])
    )
  })

  it('ignores usage for an agent that is no longer tracked', () => {
    const manager = new AgentManager()
    const changed = vi.fn()
    manager.on('changed', changed)

    ;(manager as unknown as WithLiveUsage).applyLiveUsage('missing', { tokensIn: 1 })

    expect(changed).not.toHaveBeenCalled()
  })
})
