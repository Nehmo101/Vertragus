import { describe, expect, it } from 'vitest'
import type { AgentEvent, AgentEventPayload } from './schema/events'
import {
  buildCliSession,
  CLI_SESSION_LOG_MAX,
  sessionLogFromEvents,
  sessionsEqual
} from './cliSession'

const identity = { agentId: 'a1', name: 'Caronte', roleId: 'worker' }

function event(payload: AgentEventPayload & { seq?: number; ts?: number }): AgentEvent {
  return { seq: 1, ts: 1, ...payload }
}

describe('sessionLogFromEvents', () => {
  it('keeps only this agent\'s events on a worker window', () => {
    const log = sessionLogFromEvents(
      [
        event({ type: 'agent_started', ...identity, ts: 1, providerId: 'cursor', model: 'grok' }),
        event({
          type: 'agent_progress',
          agentId: 'other',
          name: 'Ulisse',
          roleId: 'worker',
          ts: 2,
          note: 'noise'
        }),
        event({ type: 'agent_progress', ...identity, ts: 3, note: 'compiling' }),
        event({ type: 'user_message', ts: 4, text: 'for the orchestrator' }),
        event({
          type: 'user_message',
          ts: 5,
          text: 'look at the parser',
          targetAgentId: 'a1',
          targetName: 'Caronte'
        }),
        event({ type: 'user_question', ts: 6, questionId: 'q1', question: 'ship it?' }),
        event({ type: 'agent_done', ...identity, ts: 7, summary: 'parser green', status: 'success' })
      ],
      'a1',
      false
    )
    expect(log.map((entry) => entry.kind)).toEqual(['started', 'progress', 'message', 'done'])
    expect(log[2]).toMatchObject({ kind: 'message', text: 'look at the parser' })
    expect(log[0]).toMatchObject({ kind: 'started', text: 'grok' })
  })

  it('lets the orchestrator see steering, ask_user and its own idle, not the team\'s progress', () => {
    const orch = { agentId: 'orch', name: 'Virgilio', roleId: 'orchestrator' }
    const log = sessionLogFromEvents(
      [
        event({ type: 'user_message', ts: 1, text: 'fix the panel' }),
        event({
          type: 'agent_progress',
          ...identity,
          ts: 2,
          note: 'worker milestone — not the orch log'
        }),
        event({ type: 'user_question', ts: 3, questionId: 'q', question: 'merge now?' }),
        event({ type: 'orchestrator_idle', ...orch, ts: 4, idleSec: 120 }),
        event({
          type: 'user_message',
          ts: 5,
          text: 'relay this',
          targetAgentId: 'a1',
          targetName: 'Caronte'
        })
      ],
      'orch',
      true
    )
    expect(log.map((entry) => [entry.kind, entry.text])).toEqual([
      ['message', 'fix the panel'],
      ['user-question', 'merge now?'],
      ['idle', '120'],
      ['message', 'relay this']
    ])
  })

  it('caps the log at the ring size from the newest end', () => {
    const events = Array.from({ length: CLI_SESSION_LOG_MAX + 5 }, (_, index) =>
      event({
        type: 'agent_progress',
        ...identity,
        seq: index + 1,
        ts: index + 1,
        note: `n${index}`
      })
    )
    const log = sessionLogFromEvents(events, 'a1', false)
    expect(log).toHaveLength(CLI_SESSION_LOG_MAX)
    expect(log[0]?.text).toBe('n5')
    expect(log.at(-1)?.text).toBe(`n${CLI_SESSION_LOG_MAX + 4}`)
  })
})

describe('buildCliSession', () => {
  it('omits empty optional fields so attach payloads stay small', () => {
    const session = buildCliSession({
      workspaceId: 'ws1',
      agentId: 'a1',
      state: 'working',
      kind: 'agent',
      events: []
    })
    expect(session).toEqual({
      workspaceId: 'ws1',
      state: 'working',
      kind: 'agent',
      log: []
    })
    expect(session).not.toHaveProperty('branch')
    expect(session).not.toHaveProperty('idle')
    expect(session).not.toHaveProperty('pendingQuestion')
  })

  it('carries branch, idle and questions when they exist', () => {
    const session = buildCliSession({
      workspaceId: 'ws1',
      agentId: 'orch',
      state: 'working',
      kind: 'orchestrator',
      branch: 'vertragus/limbo/bernardo',
      idle: true,
      pendingQuestion: { questionId: 'pq', question: 'which path?' },
      userQuestion: { questionId: 'uq', question: 'ship it?' },
      events: [event({ type: 'user_message', ts: 1, text: 'go' })]
    })
    expect(session.branch).toBe('vertragus/limbo/bernardo')
    expect(session.idle).toBe(true)
    expect(session.pendingQuestion).toEqual({ questionId: 'pq', question: 'which path?' })
    expect(session.userQuestion).toEqual({ questionId: 'uq', question: 'ship it?' })
    expect(session.log).toEqual([{ kind: 'message', text: 'go', ts: 1 }])
  })
})

describe('sessionsEqual', () => {
  it('treats identical snapshots as equal and a field flip as not', () => {
    const a = buildCliSession({
      workspaceId: 'ws1',
      agentId: 'a1',
      state: 'working',
      kind: 'agent',
      events: []
    })
    expect(sessionsEqual(a, { ...a })).toBe(true)
    expect(sessionsEqual(a, { ...a, state: 'stopped' })).toBe(false)
    expect(sessionsEqual(undefined, a)).toBe(false)
    expect(sessionsEqual(undefined, undefined)).toBe(true)
  })
})
