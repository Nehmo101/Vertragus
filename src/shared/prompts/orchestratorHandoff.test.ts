import { describe, expect, it } from 'vitest'
import { buildHandoffPackage } from '../schema/handoff'
import {
  buildSuccessorOrchestratorSystemPrompt,
  formatHandoffSeed
} from './orchestratorHandoff'

const pkg = buildHandoffPackage({
  workspaceId: 'ws',
  workspaceName: 'Paradiso',
  profileId: 'p1',
  createdAt: 1,
  reason: 'context_full',
  predecessor: { agentId: 'o1', name: 'Virgilio', providerId: 'claude' },
  successorAgentId: 'o2',
  eventCursor: 42,
  agents: [{ agentId: 'a1', name: 'Caronte', role: 'worker', status: 'working' }],
  openQuestions: [{ questionId: 'q1', agentId: 'a1', question: 'merge which branch?' }],
  recentEvents: [],
  nextActions: ['Answer Caronte, then inspect the branch']
})

describe('formatHandoffSeed', () => {
  it('tells the successor the cursor, open questions and that this is a continuation', () => {
    const seed = formatHandoffSeed(pkg)
    expect(seed).toContain('successor of Virgilio')
    expect(seed).toContain('cursor 42')
    expect(seed).toContain('q1')
    expect(seed).toContain('merge which branch?')
    expect(seed).toContain('continuation of the same run')
    expect(seed).toContain('Do not call record_retro until the goal is actually reached')
  })
})

describe('buildSuccessorOrchestratorSystemPrompt', () => {
  it('keeps the loop rules and appends the package', () => {
    const prompt = buildSuccessorOrchestratorSystemPrompt(
      {
        workspaceName: 'Paradiso',
        repoPath: '/repo',
        rolesWithLimits: [{ id: 'worker' }]
      },
      pkg
    )
    expect(prompt).toContain('You are the orchestrator of the Vertragus workspace')
    expect(prompt).toContain('request_succession')
    expect(prompt).toContain('"eventCursor": 42')
  })
})
