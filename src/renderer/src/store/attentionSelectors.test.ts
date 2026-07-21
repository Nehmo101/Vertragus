import { describe, expect, it } from 'vitest'
import type { AgentInstanceInfo } from '@shared/agents'
import type {
  MultiAgentRunSnapshot,
  OrchestratorSnapshot,
  SubagentSupportRequest,
  WorkspaceSessionSummary
} from '@shared/orchestrator'
import type { ApprovalItem } from '@shared/remote'
import {
  selectPendingFeedbackCount,
  type AttentionSelectorState,
  workspaceNeedsUserFeedback
} from '@renderer/store/attentionSelectors'

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

function session(
  id: string,
  profileId: string,
  name = id
): WorkspaceSessionSummary {
  return {
    id,
    profileId,
    profileName: profileId,
    name,
    taskSummary: undefined,
    sequence: 1,
    startedAt: 1,
    active: true
  }
}

function snapshot(
  profileId: string,
  workspaceSessionId: string,
  overrides: Partial<OrchestratorSnapshot> = {}
): OrchestratorSnapshot {
  return {
    profileId,
    workspaceSessionId,
    goal: null,
    tasks: [],
    ...overrides
  }
}

function pendingPlan(): NonNullable<OrchestratorSnapshot['pendingPlan']> {
  return {
    planId: 'plan-1',
    usedFallback: false,
    rejected: false,
    validationIssues: [],
    plan: { version: 1, goal: 'Review me', maxParallel: 1, tasks: [] }
  }
}

function subagentRequest(
  id: string,
  status: SubagentSupportRequest['status']
): SubagentSupportRequest {
  return {
    id,
    taskId: `task-${id}`,
    question: 'Need help?',
    status,
    createdAt: 1
  }
}

function multiAgentRun(
  id: string,
  status: MultiAgentRunSnapshot['status']
): MultiAgentRunSnapshot {
  return {
    id,
    parentTaskId: `parent-${id}`,
    title: id,
    role: 'worker',
    status,
    candidateTaskIds: [],
    startedAt: 1
  }
}

function missionApproval(
  profileId: string,
  workspaceSessionId: string
): ApprovalItem {
  return {
    id: `approval:${workspaceSessionId}`,
    kind: 'plan-review',
    profileId,
    workspaceSessionId,
    title: 'Mission approval',
    summary: 'Needs a decision',
    createdAt: 1,
    actions: ['plan.approve', 'plan.reject']
  }
}

function emptyState(): AttentionSelectorState {
  return { agents: [], orchestrators: {}, workspaceSessions: [] }
}

describe('selectPendingFeedbackCount', () => {
  it('returns 0 for an empty store or workspaces without feedback need', () => {
    expect(selectPendingFeedbackCount(emptyState())).toBe(0)

    const idle = snapshot('alpha', 'session-alpha')
    const state: AttentionSelectorState = {
      agents: [agent('running', 'alpha')],
      orchestrators: { 'session-alpha': idle },
      workspaceSessions: [session('session-alpha', 'alpha', 'Rivendell')]
    }

    expect(selectPendingFeedbackCount(state)).toBe(0)
    expect(workspaceNeedsUserFeedback(state, 'alpha', 'session-alpha')).toBe(false)
  })

  it('returns 1 for exactly one workspace with a pendingPlan', () => {
    const withPlan = snapshot('alpha', 'session-alpha', { pendingPlan: pendingPlan() })
    const state: AttentionSelectorState = {
      agents: [],
      orchestrators: { 'session-alpha': withPlan },
      workspaceSessions: [session('session-alpha', 'alpha', 'Rivendell')]
    }

    expect(selectPendingFeedbackCount(state)).toBe(1)
    expect(workspaceNeedsUserFeedback(state, 'alpha', 'session-alpha')).toBe(true)
  })

  it('returns 1 for exactly one workspace with a mission-approval signal', () => {
    const withApproval = snapshot('alpha', 'session-alpha', {
      pendingApprovals: [missionApproval('alpha', 'session-alpha')]
    })
    const state: AttentionSelectorState = {
      agents: [],
      orchestrators: { 'session-alpha': withApproval },
      workspaceSessions: [session('session-alpha', 'alpha', 'Rivendell')]
    }

    expect(selectPendingFeedbackCount(state)).toBe(1)
    expect(workspaceNeedsUserFeedback(state, 'alpha', 'session-alpha')).toBe(true)
  })

  it('counts an open subagent request with status pending', () => {
    const withRequest = snapshot('alpha', 'session-alpha', {
      subagentRequests: [subagentRequest('ask-1', 'pending')]
    })
    const state: AttentionSelectorState = {
      agents: [],
      orchestrators: { 'session-alpha': withRequest },
      workspaceSessions: [session('session-alpha', 'alpha', 'Rivendell')]
    }

    expect(selectPendingFeedbackCount(state)).toBe(1)
  })

  it('counts a multiAgentRun with status awaiting-review', () => {
    const withRun = snapshot('alpha', 'session-alpha', {
      multiAgentRuns: [multiAgentRun('run-1', 'awaiting-review')]
    })
    const state: AttentionSelectorState = {
      agents: [],
      orchestrators: { 'session-alpha': withRun },
      workspaceSessions: [session('session-alpha', 'alpha', 'Rivendell')]
    }

    expect(selectPendingFeedbackCount(state)).toBe(1)
  })

  it('counts multiple signals in the same workspace as 1 (distinct workspace scope)', () => {
    const waiting = {
      ...agent('pippin', 'alpha'),
      workspaceSessionId: 'session-alpha',
      status: 'waiting' as const
    }
    const busy = snapshot('alpha', 'session-alpha', {
      pendingPlan: pendingPlan(),
      subagentRequests: [subagentRequest('ask-1', 'pending')],
      multiAgentRuns: [multiAgentRun('run-1', 'awaiting-review')],
      pendingApprovals: [missionApproval('alpha', 'session-alpha')]
    })
    const state: AttentionSelectorState = {
      agents: [waiting],
      orchestrators: { 'session-alpha': busy },
      workspaceSessions: [session('session-alpha', 'alpha', 'Rivendell')]
    }

    expect(selectPendingFeedbackCount(state)).toBe(1)
  })

  it('counts each workspace with feedback need separately', () => {
    const alpha = snapshot('alpha', 'session-alpha', { pendingPlan: pendingPlan() })
    const beta = snapshot('beta', 'session-beta', {
      multiAgentRuns: [multiAgentRun('run-beta', 'awaiting-review')]
    })
    const state: AttentionSelectorState = {
      agents: [],
      orchestrators: {
        'session-alpha': alpha,
        'session-beta': beta
      },
      workspaceSessions: [
        session('session-alpha', 'alpha', 'Rivendell'),
        session('session-beta', 'beta', 'Moria')
      ]
    }

    expect(selectPendingFeedbackCount(state)).toBe(2)
  })

  it('does not count answered/stopped subagent requests or finished multi-agent runs', () => {
    const settled = snapshot('alpha', 'session-alpha', {
      subagentRequests: [
        subagentRequest('answered', 'answered'),
        subagentRequest('stopped', 'stopped')
      ],
      multiAgentRuns: [
        multiAgentRun('accepted', 'accepted'),
        multiAgentRun('rejected', 'rejected'),
        multiAgentRun('running', 'running')
      ]
    })
    const state: AttentionSelectorState = {
      agents: [{ ...agent('done', 'alpha'), status: 'stopped' as const }],
      orchestrators: { 'session-alpha': settled },
      workspaceSessions: [session('session-alpha', 'alpha', 'Rivendell')]
    }

    expect(selectPendingFeedbackCount(state)).toBe(0)
    expect(workspaceNeedsUserFeedback(state, 'alpha', 'session-alpha')).toBe(false)
  })

  it('ignores stale sessions that are no longer in workspaceSessions', () => {
    const live = snapshot('alpha', 'session-alpha')
    const stale = snapshot('alpha', 'removed-session', {
      pendingPlan: pendingPlan(),
      subagentRequests: [subagentRequest('stale-ask', 'pending')],
      multiAgentRuns: [multiAgentRun('stale-run', 'awaiting-review')]
    })
    const waitingElsewhere = {
      ...agent('stale-waiter', 'alpha'),
      workspaceSessionId: 'removed-session',
      status: 'waiting' as const
    }
    const state: AttentionSelectorState = {
      agents: [waitingElsewhere],
      orchestrators: {
        'session-alpha': live,
        'removed-session': stale
      },
      workspaceSessions: [session('session-alpha', 'alpha', 'Rivendell')]
    }

    expect(workspaceNeedsUserFeedback(state, 'alpha', 'session-alpha')).toBe(false)
    expect(selectPendingFeedbackCount(state)).toBe(0)
  })
})
