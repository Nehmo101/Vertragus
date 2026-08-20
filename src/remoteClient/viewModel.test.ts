import { describe, expect, it } from 'vitest'
import type { RemoteAgentSummary, RemoteWorkspaceSummary } from '@shared/remote/protocol'
import {
  agentDotKind,
  agentNeedsAttention,
  agentStatusLine,
  endedWorkspaces,
  hasActiveWorkspace,
  isWorkspaceExpanded,
  liveWorkspaces,
  orderWorkspaces,
  workspaceGoalLine,
  workspaceNeedsAttention
} from './viewModel'

function agent(overrides: Partial<RemoteAgentSummary> = {}): RemoteAgentSummary {
  return {
    agentId: 'a1',
    name: 'Caronte',
    roleId: 'worker',
    roleLabel: 'Worker',
    roleColor: '#2f7d6d',
    state: 'working',
    ...overrides
  }
}

function workspace(overrides: Partial<RemoteWorkspaceSummary> = {}): RemoteWorkspaceSummary {
  return {
    workspaceId: 'w1',
    name: 'Paradiso',
    profileId: 'p1',
    active: true,
    agents: [agent()],
    ...overrides
  }
}

const labels = { working: 'arbeitet', waiting: 'wartet', stopped: 'beendet' }

describe('orderWorkspaces', () => {
  it('puts live cards above ended ones', () => {
    const ended = workspace({ workspaceId: 'old', active: false })
    const live = workspace({ workspaceId: 'now', active: true })
    expect(orderWorkspaces([ended, live]).map((entry) => entry.workspaceId)).toEqual(['now', 'old'])
  })
})

describe('live vs ended', () => {
  it('splits the list without dropping either side', () => {
    const items = [
      workspace({ workspaceId: 'a', active: true }),
      workspace({ workspaceId: 'b', active: false })
    ]
    expect(hasActiveWorkspace(items)).toBe(true)
    expect(liveWorkspaces(items)).toHaveLength(1)
    expect(endedWorkspaces(items)).toHaveLength(1)
    expect(hasActiveWorkspace(endedWorkspaces(items))).toBe(false)
  })
})

describe('attention', () => {
  it('flags a user question and a waiting subagent', () => {
    expect(
      workspaceNeedsAttention(
        workspace({ userQuestion: { questionId: 'q', question: 'Ship it?' } })
      )
    ).toBe(true)
    expect(
      agentNeedsAttention(agent({ pendingQuestion: 'Use bcrypt?' }))
    ).toBe(true)
    expect(agentNeedsAttention(agent({ roleId: 'orchestrator', pendingQuestion: 'Go?' }))).toBe(
      false
    )
  })
})

describe('expansion', () => {
  it('defaults live and attention cards open, ended cards shut', () => {
    expect(isWorkspaceExpanded(workspace({ active: true }), {})).toBe(true)
    expect(isWorkspaceExpanded(workspace({ active: false }), {})).toBe(false)
    expect(
      isWorkspaceExpanded(
        workspace({
          active: false,
          userQuestion: { questionId: 'q', question: 'Still there?' }
        }),
        {}
      )
    ).toBe(true)
    expect(isWorkspaceExpanded(workspace({ active: true }), { w1: false })).toBe(false)
  })
})

describe('agent status line', () => {
  it('reads role · task while working, and keeps the task after stop', () => {
    expect(agentStatusLine(agent({ statusText: 'T-142' }), labels)).toBe('Worker · T-142')
    expect(agentStatusLine(agent({ state: 'stopped', statusText: 'T-142' }), labels)).toBe(
      'Worker · beendet · T-142'
    )
    expect(agentDotKind(agent({ roleId: 'orchestrator' }))).toBe('working-orchestrator')
    expect(agentDotKind(agent({ state: 'waiting' }))).toBe('idle')
  })
})

describe('goal line', () => {
  const copy = { goal: (goal: string) => `Ziel: ${goal}`, noGoal: 'Kein Ziel' }
  it('quotes a delivered goal and tells the truth on a bare start', () => {
    expect(workspaceGoalLine(workspace({ goalText: 'Fix login' }), copy)).toBe('Ziel: Fix login')
    expect(workspaceGoalLine(workspace({ active: true }), copy)).toBe('Kein Ziel')
    expect(workspaceGoalLine(workspace({ active: false }), copy)).toBeUndefined()
  })
})
