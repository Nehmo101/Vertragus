import { describe, expect, it } from 'vitest'
import type { AgentInstanceInfo, OrcaEvent } from '@shared/agents'
import {
  effectivePaneReadable,
  visibleWorkspaceAgents,
  workspaceAgentHistory,
  workspaceAgents,
  workspaceEvents
} from '@renderer/store/useAppStore'

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

  it('hides finished subagents until they are reopened from history', () => {
    const finished = { ...agent('finished', 'alpha'), status: 'stopped' as const, startedAt: 2 }
    const failed = { ...agent('failed', 'alpha'), status: 'error' as const, startedAt: 3 }
    const running = agent('running', 'alpha')
    const state = {
      agents: [finished, failed, running, agent('other', 'beta')],
      activeProfileId: 'alpha',
      reopenedAgentIds: ['finished']
    }

    expect(visibleWorkspaceAgents(state).map((item) => item.id)).toEqual([
      'finished',
      'running'
    ])
    expect(workspaceAgentHistory(state).map((item) => item.id)).toEqual([
      'failed',
      'finished'
    ])
  })

  it('resolves a pane readable mode from its override, else the global default', () => {
    expect(effectivePaneReadable({ cliReadable: true, paneReadable: {} }, 'alpha')).toBe(true)
    expect(effectivePaneReadable({ cliReadable: false, paneReadable: {} }, 'alpha')).toBe(false)
    expect(effectivePaneReadable({ cliReadable: false, paneReadable: { alpha: true } }, 'alpha')).toBe(true)
    expect(effectivePaneReadable({ cliReadable: true, paneReadable: { alpha: false } }, 'alpha')).toBe(false)
  })
})
