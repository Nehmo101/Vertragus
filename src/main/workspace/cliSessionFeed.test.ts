import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '@shared/schema/events'
import { cliChromeForWorkspace, workspaceOwningAgent } from './cliSessionFeed'

const identity = { agentId: 'a1', name: 'Caronte', roleId: 'worker' }

function event(partial: Omit<AgentEvent, 'seq'> & { seq?: number }): AgentEvent {
  return { seq: partial.seq ?? 1, ...partial } as AgentEvent
}

describe('cliChromeForWorkspace', () => {
  it('pushes the orchestrator first, then each listed agent, with host-truth fields', () => {
    const events = [
      event({ type: 'user_message', ts: 1, text: 'fix the parser' }),
      event({ type: 'agent_progress', ...identity, ts: 2, note: 'rewriting lexer' })
    ]
    const rows = cliChromeForWorkspace(
      {
        workspaceId: 'ws1',
        orchestrator: { agentId: 'orch', branch: 'vertragus/limbo/virgilio' },
        orchestratorAlive: true,
        orchestratorIdle: true,
        orchestratorTaskText: 'fix the parser',
        listAgents: () => [
          { agentId: 'a1', status: 'working', branch: 'vertragus/limbo/caronte' },
          { agentId: 'lead-1', status: 'starting', kind: 'lead', branch: 'vertragus/limbo/ulisse' }
        ],
        events: { all: () => events }
      },
      {
        agentTask: (_workspaceId, agentId) => (agentId === 'a1' ? 'rewrite lexer' : undefined),
        openQuestion: (_workspaceId, agentId) => {
          if (agentId === 'user') return { questionId: 'uq', question: 'ship it?' }
          if (agentId === 'a1') return { questionId: 'pq', question: 'which path?' }
          return undefined
        }
      }
    )

    expect(rows.map((row) => row.agentId)).toEqual(['orch', 'a1', 'lead-1'])
    expect(rows[0]).toMatchObject({
      agentId: 'orch',
      task: 'fix the parser',
      session: {
        workspaceId: 'ws1',
        state: 'working',
        kind: 'orchestrator',
        branch: 'vertragus/limbo/virgilio',
        idle: true,
        userQuestion: { questionId: 'uq', question: 'ship it?' }
      }
    })
    expect(rows[0]!.session.log.map((entry) => entry.kind)).toEqual(['message'])
    expect(rows[1]).toMatchObject({
      task: 'rewrite lexer',
      session: {
        state: 'working',
        kind: 'agent',
        branch: 'vertragus/limbo/caronte',
        pendingQuestion: { questionId: 'pq', question: 'which path?' }
      }
    })
    expect(rows[1]!.session.log.map((entry) => entry.kind)).toEqual(['progress'])
    expect(rows[2]!.session).toMatchObject({ state: 'waiting', kind: 'lead' })
    expect(rows[2]!.session.log).toEqual([])
  })

  it('marks a dead orchestrator stopped and a finished worker stopped', () => {
    const rows = cliChromeForWorkspace(
      {
        workspaceId: 'ws1',
        orchestrator: { agentId: 'orch', branch: 'vertragus/x/virgilio' },
        orchestratorAlive: false,
        orchestratorIdle: false,
        listAgents: () => [{ agentId: 'a1', status: 'stopped', branch: 'vertragus/x/caronte' }],
        events: { all: () => [] }
      },
      {
        agentTask: () => undefined,
        openQuestion: () => undefined
      }
    )
    expect(rows[0]!.session.state).toBe('stopped')
    expect(rows[1]!.session.state).toBe('stopped')
  })
})

describe('workspaceOwningAgent', () => {
  const orch = {
    workspaceId: 'ws-orch',
    orchestrator: { agentId: 'orch', branch: 'b' },
    orchestratorAlive: true,
    orchestratorIdle: false,
    listAgents: () => [{ agentId: 'child', status: 'working' }],
    events: { all: () => [] as AgentEvent[] }
  }
  const other = {
    workspaceId: 'ws-other',
    orchestratorAlive: true,
    orchestratorIdle: false,
    listAgents: () => [{ agentId: 'stranger', status: 'working' }],
    events: { all: () => [] as AgentEvent[] }
  }

  it('finds the workspace by orchestrator id or listed agent id', () => {
    expect(workspaceOwningAgent([orch, other], 'orch')?.workspaceId).toBe('ws-orch')
    expect(workspaceOwningAgent([orch, other], 'child')?.workspaceId).toBe('ws-orch')
    expect(workspaceOwningAgent([orch, other], 'stranger')?.workspaceId).toBe('ws-other')
    expect(workspaceOwningAgent([orch, other], 'ghost')).toBeUndefined()
  })
})
