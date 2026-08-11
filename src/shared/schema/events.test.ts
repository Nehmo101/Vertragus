import { describe, expect, it } from 'vitest'
import {
  AGENT_EVENT_TYPES,
  agentEventPayloadSchema,
  agentEventSchema,
  isAgentEvent
} from './events'

const identity = { agentId: 'a1', name: 'Arlecchino', roleId: 'worker' }

describe('agent event schema', () => {
  it('covers exactly the six documented event types', () => {
    expect([...AGENT_EVENT_TYPES]).toEqual([
      'agent_started',
      'agent_done',
      'agent_question',
      'agent_progress',
      'agent_exited',
      'agent_stopped'
    ])
  })

  it('accepts a payload without envelope fields', () => {
    const parsed = agentEventPayloadSchema.parse({
      type: 'agent_progress',
      ...identity,
      note: 'compiling'
    })
    expect(parsed).toMatchObject({ type: 'agent_progress', note: 'compiling' })
  })

  it('rejects a payload that omits the agent identity', () => {
    expect(() =>
      agentEventPayloadSchema.parse({ type: 'agent_progress', note: 'x' })
    ).toThrow()
  })

  it('requires a positive seq on a full event', () => {
    const full = { type: 'agent_stopped', ...identity, seq: 1, ts: 1 }
    expect(agentEventSchema.parse(full)).toMatchObject({ seq: 1 })
    expect(() => agentEventSchema.parse({ ...full, seq: 0 })).toThrow()
  })

  it('keeps done status inside the enum and defaults nothing implicitly', () => {
    expect(() =>
      agentEventPayloadSchema.parse({
        type: 'agent_done',
        ...identity,
        summary: 's',
        status: 'partial'
      })
    ).toThrow()
  })

  it('marks unconfirmed exits explicitly', () => {
    const parsed = agentEventPayloadSchema.parse({
      type: 'agent_exited',
      ...identity,
      exitCode: 1,
      confirmed: false
    })
    expect(parsed).toMatchObject({ confirmed: false, exitCode: 1 })
  })

  it('allows a null exit code for signal deaths', () => {
    expect(
      agentEventPayloadSchema.parse({
        type: 'agent_exited',
        ...identity,
        exitCode: null,
        confirmed: false
      })
    ).toMatchObject({ exitCode: null })
  })

  it('narrows with isAgentEvent', () => {
    const event = agentEventSchema.parse({
      type: 'agent_question',
      ...identity,
      questionId: 'q1',
      question: 'which path?',
      seq: 3,
      ts: 5
    })
    expect(isAgentEvent(event, 'agent_question')).toBe(true)
    expect(isAgentEvent(event, 'agent_done')).toBe(false)
    if (isAgentEvent(event, 'agent_question')) expect(event.questionId).toBe('q1')
  })
})
