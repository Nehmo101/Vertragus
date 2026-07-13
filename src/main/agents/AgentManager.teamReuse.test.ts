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
import { AgentManager, type RunTaskRequest } from '@main/agents/AgentManager'

describe('AgentManager team reuse intent', () => {
  it('ignores terminal protocol replies but protects explicit user interaction', () => {
    const manager = new AgentManager()
    const agent: AgentInstanceInfo = {
      id: 'sub-01',
      name: 'Gimli',
      provider: 'cursor',
      model: 'composer',
      role: 'Subagent',
      kind: 'sub',
      mode: 'interactive',
      yolo: false,
      teamRole: 'worker',
      profileId: 'profile-a',
      workspaceSessionId: 'session-a',
      workingDir: '.',
      status: 'running',
      startedAt: 1
    }
    const write = vi.fn()
    const records = (manager as unknown as { agents: Map<string, unknown> }).agents
    records.set(agent.id, { info: agent, pty: { write }, buffer: '', seq: 0 })

    const request: RunTaskRequest = {
      provider: 'cursor',
      model: 'composer',
      role: 'worker',
      taskId: 'task-1',
      prompt: 'Do the work',
      yolo: false,
      profileId: 'profile-a',
      workspaceSessionId: 'session-a'
    }
    const claim = (): unknown =>
      (manager as unknown as { claimTeamMember(req: RunTaskRequest): unknown })
        .claimTeamMember(request)

    manager.write(agent.id, '\u001b[?1;2c')
    expect(write).toHaveBeenCalledWith('\u001b[?1;2c')
    expect(claim()).toBeDefined()

    manager.markInteractiveUsed(agent.id)
    expect(claim()).toBeUndefined()
  })
})
