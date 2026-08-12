import { describe, expect, it } from 'vitest'
import type { AgentEvent, AgentEventPayload } from '../schema/events'
import type { ModelLearning } from '../schema/retro'
import { mergeModelLearnings } from './learnings'
import { computeRoutingScores } from './routingStats'
import { deriveRoleModelStats, knowledgeForSlots } from './runStats'

let seq = 0
function event(payload: AgentEventPayload): AgentEvent {
  seq += 1
  return { ...payload, seq, ts: seq * 1_000 }
}

function started(agentId: string, roleId: string, providerId?: string, model?: string): AgentEvent {
  return event({
    type: 'agent_started',
    agentId,
    name: agentId,
    roleId,
    ...(providerId ? { providerId } : {}),
    ...(model ? { model } : {})
  })
}

describe('deriveRoleModelStats', () => {
  it('folds the event stream into per role+model tallies', () => {
    const stats = deriveRoleModelStats([
      started('a1', 'worker', 'codex', 'gpt-x'),
      started('a2', 'worker', 'codex', 'gpt-x'),
      started('a3', 'reviewer', 'claude', 'sonnet'),
      event({ type: 'agent_done', agentId: 'a1', name: 'a1', roleId: 'worker', summary: 'ok', status: 'success' }),
      event({ type: 'agent_done', agentId: 'a2', name: 'a2', roleId: 'worker', summary: 'stuck', status: 'blocked' }),
      event({ type: 'agent_done', agentId: 'a3', name: 'a3', roleId: 'reviewer', summary: 'no', status: 'failed' }),
      event({ type: 'agent_stopped', agentId: 'a1', name: 'a1', roleId: 'worker' })
    ])

    expect(stats).toHaveLength(2)
    expect(stats.find((row) => row.roleId === 'worker')).toMatchObject({
      providerId: 'codex',
      model: 'gpt-x',
      started: 2,
      succeeded: 1,
      blocked: 1,
      failed: 0,
      stopped: 1
    })
    expect(stats.find((row) => row.roleId === 'reviewer')).toMatchObject({
      providerId: 'claude',
      model: 'sonnet',
      failed: 1
    })
  })

  it('counts every judged agent_done — follow-up reports are separate samples', () => {
    const stats = deriveRoleModelStats([
      started('a1', 'worker', 'codex', 'gpt-x'),
      event({ type: 'agent_done', agentId: 'a1', name: 'a1', roleId: 'worker', summary: '1', status: 'success' }),
      event({ type: 'agent_done', agentId: 'a1', name: 'a1', roleId: 'worker', summary: '2', status: 'success' })
    ])
    expect(stats[0]).toMatchObject({ started: 1, succeeded: 2 })
  })

  it('counts only unconfirmed exits — a confirmed exit was already judged by its agent_done', () => {
    const stats = deriveRoleModelStats([
      started('a1', 'worker', 'codex', 'gpt-x'),
      started('a2', 'worker', 'codex', 'gpt-x'),
      event({ type: 'agent_exited', agentId: 'a1', name: 'a1', roleId: 'worker', exitCode: 0, confirmed: true }),
      event({ type: 'agent_exited', agentId: 'a2', name: 'a2', roleId: 'worker', exitCode: 1, confirmed: false })
    ])
    expect(stats[0]).toMatchObject({ unconfirmedExits: 1 })
  })

  it('falls back to the event roleId and empty identity when agent_started is missing', () => {
    const stats = deriveRoleModelStats([
      event({ type: 'agent_done', agentId: 'ghost', name: 'ghost', roleId: 'worker', summary: 'ok', status: 'success' })
    ])
    expect(stats[0]).toMatchObject({ roleId: 'worker', providerId: '', model: '', succeeded: 1 })
  })

  it('ignores question and progress events', () => {
    const stats = deriveRoleModelStats([
      started('a1', 'worker', 'codex', 'gpt-x'),
      event({ type: 'agent_question', agentId: 'a1', name: 'a1', roleId: 'worker', questionId: 'q1', question: '?' }),
      event({ type: 'agent_progress', agentId: 'a1', name: 'a1', roleId: 'worker', note: 'busy' })
    ])
    expect(stats[0]).toMatchObject({ started: 1, succeeded: 0, blocked: 0, failed: 0 })
  })
})

describe('knowledgeForSlots', () => {
  function learningsFor(providerId: string, model: string): ModelLearning[] {
    return mergeModelLearnings(
      [],
      [
        { providerId, model, kind: 'strength', insight: 'stark bei UI', source: 'orchestrator' },
        { providerId, model, kind: 'weakness', insight: 'schwach bei Migrationen', source: 'orchestrator' }
      ],
      1_000
    ).all
  }

  const scoredRetro = {
    id: 'run-1',
    workspaceId: 'ws-1',
    workspaceName: 'Limbo',
    profileId: 'p1',
    summary: '',
    createdAt: 1,
    endedAt: 2,
    stats: [
      {
        roleId: 'worker',
        providerId: 'codex',
        model: 'gpt-x',
        started: 5,
        succeeded: 4,
        blocked: 0,
        failed: 1,
        unconfirmedExits: 0,
        stopped: 5
      }
    ]
  }

  it('pairs each slot with its score and learning texts', () => {
    const knowledge = knowledgeForSlots(
      [{ roleId: 'worker', providerId: 'codex', model: 'gpt-x' }],
      learningsFor('codex', 'gpt-x'),
      computeRoutingScores([scoredRetro])
    )
    expect(knowledge).toHaveLength(1)
    expect(knowledge[0]).toMatchObject({
      roleId: 'worker',
      providerId: 'codex',
      model: 'gpt-x',
      strengths: ['stark bei UI'],
      weaknesses: ['schwach bei Migrationen']
    })
    expect(knowledge[0]!.score).toMatchObject({ samples: 5, successRate: 4 / 5 })
  })

  it('omits slots without any evidence and deduplicates identical slots', () => {
    const knowledge = knowledgeForSlots(
      [
        { roleId: 'worker', providerId: 'codex', model: 'gpt-x' },
        { roleId: 'worker', providerId: 'codex', model: 'gpt-x' },
        { roleId: 'tester', providerId: 'claude', model: 'unknown' }
      ],
      learningsFor('codex', 'gpt-x'),
      []
    )
    expect(knowledge).toHaveLength(1)
    expect(knowledge[0]!.score).toBeUndefined()
  })
})
