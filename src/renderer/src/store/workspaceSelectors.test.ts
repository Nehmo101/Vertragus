import { describe, expect, it } from 'vitest'
import type { AgentInstanceInfo, OrcaEvent } from '@shared/agents'
import { workspaceAgents, workspaceEvents } from '@renderer/store/useAppStore'

function agent(id: string, profileId?: string): AgentInstanceInfo {
  return {
    id,
    profileId,
    name: id,
    provider: 'codex',
    model: '',
    role: 'Subagent',
    kind: 'sub',
    mode: 'interactive',
    yolo: false,
    workingDir: '.',
    status: 'running',
    startedAt: 1
  }
}

describe('workspace renderer selectors', () => {
  it('shows the selected workspace while keeping background agents in state', () => {
    const agents = [agent('alpha', 'alpha'), agent('beta', 'beta'), agent('global')]

    expect(workspaceAgents({ agents, activeProfileId: 'alpha' }).map((item) => item.id))
      .toEqual(['alpha', 'global'])
    expect(agents.map((item) => item.id)).toEqual(['alpha', 'beta', 'global'])
  })

  it('keeps event logs separated per workspace', () => {
    const events: OrcaEvent[] = [
      { time: 1, text: 'alpha', tone: 'info', profileId: 'alpha' },
      { time: 2, text: 'beta', tone: 'info', profileId: 'beta' },
      { time: 3, text: 'global', tone: 'info' }
    ]

    expect(workspaceEvents({ events, activeProfileId: 'beta' }).map((event) => event.text))
      .toEqual(['beta', 'global'])
  })
})
