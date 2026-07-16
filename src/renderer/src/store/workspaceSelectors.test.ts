import { describe, expect, it } from 'vitest'
import type { AgentInstanceInfo, OrcaEvent } from '@shared/agents'
import type { OrcaTask, OrchestratorSnapshot } from '@shared/orchestrator'
import {
  effectivePaneReadable,
  profileHasRunningAgents,
  visibleWorkspaceAgents,
  workspaceAgentHistory,
  workspaceAgents,
  workspaceEvents,
  workspaceTaskSummary,
  workspaceUserAttention
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

function task(id: string, status: OrcaTask['status']): OrcaTask {
  return {
    id,
    title: id,
    role: 'worker',
    status,
    note: 'awaiting-user injected text must not drive UI state',
    createdAt: 1
  }
}

function snapshot(
  profileId: string,
  workspaceSessionId: string,
  tasks: OrcaTask[] = []
): OrchestratorSnapshot {
  return {
    profileId,
    workspaceSessionId,
    goal: null,
    tasks
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

  it('blocks profile deletion only for running or waiting agents of that profile', () => {
    const stopped = { ...agent('stopped', 'alpha'), status: 'stopped' as const }
    const waiting = { ...agent('waiting', 'alpha'), status: 'waiting' as const }

    expect(profileHasRunningAgents([agent('beta', 'beta'), agent('global'), stopped], 'alpha'))
      .toBe(false)
    expect(profileHasRunningAgents([waiting, agent('beta', 'beta')], 'alpha')).toBe(true)
    expect(profileHasRunningAgents([agent('running', 'alpha')], 'alpha')).toBe(true)
  })
})

describe('workspace user-attention aggregation', () => {
  it('prioritizes an orchestrator plan review over a waiting subagent', () => {
    const orchestrator = snapshot('alpha', 'session-alpha')
    orchestrator.pendingPlan = {
      planId: 'plan-1',
      usedFallback: false,
      rejected: false,
      validationIssues: [],
      plan: { version: 1, goal: 'Review me', maxParallel: 1, tasks: [] }
    }
    const waitingSubagent = {
      ...agent('subagent', 'alpha'),
      workspaceSessionId: 'session-alpha',
      status: 'waiting' as const
    }

    expect(workspaceUserAttention(
      { agents: [waitingSubagent], orchestrators: { 'session-alpha': orchestrator } },
      'alpha',
      'session-alpha'
    )).toEqual({ source: 'orchestrator' })
  })

  it('uses a waiting orchestrator pane as a user-input signal', () => {
    const waitingOrchestrator = {
      ...agent('orchestrator', 'alpha'),
      kind: 'orchestrator' as const,
      workspaceSessionId: 'session-alpha',
      status: 'waiting' as const
    }

    expect(workspaceUserAttention(
      { agents: [waitingOrchestrator], orchestrators: {} },
      'alpha',
      'session-alpha'
    )).toEqual({
      source: 'orchestrator',
      agentId: 'orchestrator',
      agentName: 'orchestrator'
    })
  })

  it('falls back to any waiting subagent in the same workspace', () => {
    const waitingSubagent = {
      ...agent('pippin', 'alpha'),
      workspaceSessionId: 'session-alpha',
      status: 'waiting' as const
    }

    expect(workspaceUserAttention(
      { agents: [waitingSubagent], orchestrators: {} },
      'alpha',
      'session-alpha'
    )).toEqual({ source: 'subagent', agentId: 'pippin', agentName: 'pippin' })
  })

  it('ignores running, completed, failed, cross-workspace and text-only signals', () => {
    const alpha = snapshot('alpha', 'session-alpha', [
      task('running', 'running'),
      task('completed', 'success'),
      task('failed', 'error')
    ])
    alpha.activity = {
      phase: 'blocked',
      summary: 'awaiting-user is only untrusted display text here',
      details: [],
      updatedAt: 1
    }
    const beta = snapshot('beta', 'session-beta')
    beta.activity = {
      phase: 'awaiting-review',
      summary: 'Real review in another workspace',
      details: [],
      updatedAt: 1
    }
    const removed = snapshot('alpha', 'removed-session')
    removed.pendingPlan = {
      planId: 'stale-plan',
      usedFallback: false,
      rejected: false,
      validationIssues: [],
      plan: { version: 1, goal: 'Removed workspace', maxParallel: 1, tasks: [] }
    }
    const agents = [
      agent('running', 'alpha'),
      { ...agent('completed', 'alpha'), status: 'stopped' as const },
      { ...agent('failed', 'alpha'), status: 'error' as const },
      { ...agent('other-workspace', 'beta'), workspaceSessionId: 'session-beta', status: 'waiting' as const },
      { ...agent('global'), status: 'waiting' as const }
    ]
    const state = {
      agents,
      orchestrators: {
        'session-alpha': alpha,
        'session-beta': beta,
        'removed-session': removed
      },
      workspaceSessions: [
        {
          id: 'session-alpha',
          profileId: 'alpha',
          profileName: 'Alpha',
          name: 'Rivendell',
          taskSummary: undefined,
          sequence: 1,
          startedAt: 1,
          active: true
        }
      ]
    }

    expect(workspaceUserAttention(state, 'alpha', 'session-alpha')).toBeNull()
    expect(workspaceUserAttention(state, 'alpha')).toBeNull()
  })
})

describe('workspace task-summary selection', () => {
  const workspaceSessions = [
    {
      id: 'session-alpha',
      profileId: 'alpha',
      profileName: 'Alpha',
      name: 'Rivendell',
      taskSummary: 'Alpha-Aufgabe',
      sequence: 1,
      startedAt: 1,
      active: true
    },
    {
      id: 'session-beta',
      profileId: 'beta',
      profileName: 'Beta',
      name: 'Moria',
      taskSummary: 'Beta-Aufgabe',
      sequence: 1,
      startedAt: 2,
      active: true
    }
  ]

  it('returns only the summary owned by the requested workspace', () => {
    expect(workspaceTaskSummary({ workspaceSessions }, 'alpha', 'session-alpha'))
      .toBe('Alpha-Aufgabe')
    expect(workspaceTaskSummary({ workspaceSessions }, 'beta', 'session-beta'))
      .toBe('Beta-Aufgabe')
  })

  it('does not expose another profile or a missing session summary', () => {
    expect(workspaceTaskSummary({ workspaceSessions }, 'alpha', 'session-beta')).toBeUndefined()
    expect(workspaceTaskSummary({ workspaceSessions }, 'alpha', 'missing')).toBeUndefined()
  })
})
