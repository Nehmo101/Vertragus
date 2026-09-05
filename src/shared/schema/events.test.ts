import { describe, expect, it } from 'vitest'
import {
  AGENT_EVENT_TYPES,
  agentEventPayloadSchema,
  agentEventSchema,
  isAgentEvent,
  tokenUsageSchema
} from './events'

const identity = { agentId: 'a1', name: 'Arlecchino', roleId: 'worker' }

describe('agent event schema', () => {
  it('covers exactly the documented event types', () => {
    expect([...AGENT_EVENT_TYPES]).toEqual([
      'agent_started',
      'agent_start_failed',
      'agent_done',
      'agent_question',
      'agent_progress',
      'agent_exited',
      'agent_stopped',
      'orchestrator_exited',
      'orchestrator_idle',
      'orchestrator_handoff_started',
      'orchestrator_started',
      'orchestrator_handoff_failed',
      'user_message',
      'user_question',
      'subtree_adopted',
      'integrate_ok',
      'integrate_conflict',
      'pull_request',
      'budget_warning'
    ])
  })

  it('A3: an automated adoption names its target, and the run pull request parses', () => {
    expect(
      agentEventPayloadSchema.parse({
        type: 'integrate_ok',
        ...identity,
        branch: 'vertragus/x/y',
        headSha: 'abc',
        target: 'checkout'
      })
    ).toMatchObject({ target: 'checkout' })
    // Absent stays legal: every integrate event written before A3 was a
    // worktree merge and must keep parsing.
    const legacy = agentEventPayloadSchema.parse({
      type: 'integrate_conflict',
      ...identity,
      branch: 'vertragus/x/y',
      conflictFiles: [],
      message: 'CONFLICT'
    })
    expect(legacy.type === 'integrate_conflict' && legacy.target).toBeUndefined()
    expect(
      agentEventPayloadSchema.safeParse({
        type: 'integrate_ok',
        ...identity,
        branch: 'b',
        headSha: 'abc',
        target: 'somewhere-else'
      }).success
    ).toBe(false)

    expect(
      agentEventPayloadSchema.parse({
        type: 'pull_request',
        ok: true,
        branch: 'vertragus/x/orch',
        base: 'main',
        url: 'https://github.com/o/r/pull/1'
      })
    ).toMatchObject({ type: 'pull_request', ok: true })
    // The failed shape is an event too — that is how the panel learns why.
    expect(
      agentEventPayloadSchema.parse({
        type: 'pull_request',
        ok: false,
        branch: 'vertragus/x/orch',
        base: 'main',
        message: 'gh is not installed'
      })
    ).toMatchObject({ ok: false, message: 'gh is not installed' })
  })

  it('E1/E4: integrate and budget events parse with their payloads', () => {
    expect(
      agentEventPayloadSchema.parse({
        type: 'integrate_ok',
        agentId: 'a1',
        name: 'Caronte',
        roleId: 'worker',
        branch: 'vertragus/x/y',
        headSha: 'abc'
      })
    ).toMatchObject({ type: 'integrate_ok' })
    expect(
      agentEventPayloadSchema.parse({
        type: 'integrate_conflict',
        agentId: 'a1',
        name: 'Caronte',
        roleId: 'worker',
        branch: 'vertragus/x/y',
        conflictFiles: ['src/a.ts'],
        message: 'CONFLICT'
      })
    ).toMatchObject({ conflictFiles: ['src/a.ts'] })
    expect(
      agentEventPayloadSchema.parse({
        type: 'budget_warning',
        usedSec: 100,
        limitSec: 120,
        exhausted: false
      })
    ).toMatchObject({ type: 'budget_warning' })
  })

  it('F: subtree_adopted names the dead lead, its area and the reparented children', () => {
    expect(
      agentEventPayloadSchema.parse({
        type: 'subtree_adopted',
        leadAgentId: 'lead-1',
        area: 'payments',
        adoptedAgentIds: ['a1', 'a2']
      })
    ).toMatchObject({ leadAgentId: 'lead-1', adoptedAgentIds: ['a1', 'a2'] })
    expect(() =>
      agentEventPayloadSchema.parse({ type: 'subtree_adopted', area: 'x', adoptedAgentIds: [] })
    ).toThrow()
  })

  it('D2/D3: user_message and user_question carry no agent identity as the sender', () => {
    expect(
      agentEventPayloadSchema.parse({ type: 'user_message', text: 'Focus on the parser.' })
    ).toMatchObject({ type: 'user_message' })
    expect(() => agentEventPayloadSchema.parse({ type: 'user_message', text: '' })).toThrow()
    expect(
      agentEventPayloadSchema.parse({
        type: 'user_message',
        text: 'Tell Colombina to run the login flow.',
        targetAgentId: 'a1',
        targetName: 'Colombina',
        relayViaAgentId: 'lead-1',
        relayViaName: 'Caronte'
      })
    ).toMatchObject({
      type: 'user_message',
      targetAgentId: 'a1',
      relayViaAgentId: 'lead-1'
    })
    expect(
      agentEventPayloadSchema.parse({ type: 'user_question', questionId: 'q1', question: 'Ship?' })
    ).toMatchObject({ questionId: 'q1' })
    expect(() =>
      agentEventPayloadSchema.parse({ type: 'user_question', question: 'Ship?' })
    ).toThrow()
  })

  it('C5: orchestrator_idle carries the silence length and stays distinct from exited', () => {
    const parsed = agentEventPayloadSchema.parse({
      type: 'orchestrator_idle',
      ...identity,
      idleSec: 120
    })
    expect(parsed).toMatchObject({ type: 'orchestrator_idle', idleSec: 120 })
    expect(() =>
      agentEventPayloadSchema.parse({ type: 'orchestrator_idle', ...identity })
    ).toThrow()
    expect(() =>
      agentEventPayloadSchema.parse({ type: 'orchestrator_idle', ...identity, idleSec: -1 })
    ).toThrow()
  })

  it('requires a message on agent_start_failed — a silent failure helps nobody', () => {
    expect(
      agentEventPayloadSchema.parse({
        type: 'agent_start_failed',
        ...identity,
        message: 'pty refused'
      })
    ).toMatchObject({ message: 'pty refused' })
    expect(() =>
      agentEventPayloadSchema.parse({ type: 'agent_start_failed', ...identity })
    ).toThrow()
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

  it('S2: quiet is an optional literal-true envelope flag — old journals stay valid', () => {
    const full = { type: 'agent_stopped', ...identity, seq: 1, ts: 1 }
    // An event without the flag (every pre-S2 journal line) parses unchanged.
    expect('quiet' in agentEventSchema.parse(full)).toBe(false)
    expect(agentEventSchema.parse({ ...full, quiet: true })).toMatchObject({ quiet: true })
    // Only literal true is a valid stamp — `quiet: false` is a producer bug.
    expect(() => agentEventSchema.parse({ ...full, quiet: false })).toThrow()
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

  it('accepts host worktree facts on agent_done and still allows a prose-only done', () => {
    expect(
      agentEventPayloadSchema.parse({
        type: 'agent_done',
        ...identity,
        summary: 's',
        status: 'success',
        branch: 'vertragus/x/y',
        headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        uncommitted: true,
        changedFiles: ['src/a.ts'],
        diffStat: ' src/a.ts | 1 +\n'
      })
    ).toMatchObject({ uncommitted: true, changedFiles: ['src/a.ts'] })
    expect(
      agentEventPayloadSchema.parse({
        type: 'agent_done',
        ...identity,
        summary: 's',
        status: 'success'
      })
    ).toMatchObject({ summary: 's' })
  })

  it('A1: agent_started may name its parent and a capped task subject; old lines stay valid', () => {
    expect(
      agentEventPayloadSchema.parse({
        type: 'agent_started',
        ...identity
      })
    ).toMatchObject({ type: 'agent_started' })
    expect(
      agentEventPayloadSchema.parse({
        type: 'agent_started',
        ...identity,
        parentId: 'worker-1',
        taskSubject: 'Fix the parser'
      })
    ).toMatchObject({ parentId: 'worker-1', taskSubject: 'Fix the parser' })
    expect(
      agentEventPayloadSchema.safeParse({
        type: 'agent_started',
        ...identity,
        taskSubject: 'x'.repeat(201)
      }).success
    ).toBe(false)
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

  it('accepts orchestrator succession events', () => {
    expect(
      agentEventPayloadSchema.parse({
        type: 'orchestrator_handoff_started',
        ...identity,
        reason: 'context_full',
        eventCursor: 12,
        successorAgentId: 'a2'
      })
    ).toMatchObject({ successorAgentId: 'a2', eventCursor: 12 })
    expect(
      agentEventPayloadSchema.parse({
        type: 'orchestrator_started',
        ...identity,
        predecessorAgentId: 'a1',
        eventCursor: 12
      })
    ).toMatchObject({ predecessorAgentId: 'a1' })
    expect(
      agentEventPayloadSchema.parse({
        type: 'orchestrator_handoff_failed',
        ...identity,
        message: 'seed failed'
      })
    ).toMatchObject({ message: 'seed failed' })
  })

  it('carries no confirmed flag on orchestrator_exited — it reports to nobody', () => {
    const parsed = agentEventPayloadSchema.parse({
      type: 'orchestrator_exited',
      ...identity,
      exitCode: null
    })
    expect(parsed).toMatchObject({ type: 'orchestrator_exited', exitCode: null })
    expect('confirmed' in parsed).toBe(false)
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

  it('accepts consumption and context tokenUsage on done, stopped and exited', () => {
    const consumption = {
      kind: 'consumption' as const,
      input: 100,
      output: 20,
      cacheRead: 5,
      cacheWrite: 8,
      total: 133
    }
    const context = { kind: 'context' as const, used: 48_000, window: 131_072 }
    for (const tokenUsage of [consumption, context]) {
      expect(
        agentEventPayloadSchema.parse({
          type: 'agent_done',
          ...identity,
          summary: 's',
          status: 'success',
          tokenUsage
        })
      ).toMatchObject({ tokenUsage })
      expect(
        agentEventPayloadSchema.parse({
          type: 'agent_stopped',
          ...identity,
          tokenUsage
        })
      ).toMatchObject({ tokenUsage })
      expect(
        agentEventPayloadSchema.parse({
          type: 'agent_exited',
          ...identity,
          exitCode: 0,
          confirmed: true,
          tokenUsage
        })
      ).toMatchObject({ tokenUsage })
    }
  })

  it('still parses done/stopped/exited without tokenUsage (old journals)', () => {
    expect(
      agentEventPayloadSchema.parse({
        type: 'agent_done',
        ...identity,
        summary: 's',
        status: 'success'
      })
    ).not.toHaveProperty('tokenUsage')
    expect(
      agentEventPayloadSchema.parse({ type: 'agent_stopped', ...identity })
    ).not.toHaveProperty('tokenUsage')
    expect(
      agentEventPayloadSchema.parse({
        type: 'agent_exited',
        ...identity,
        exitCode: null,
        confirmed: false
      })
    ).not.toHaveProperty('tokenUsage')
  })

  it('rejects negative, non-integer, extra-key and unknown-kind tokenUsage', () => {
    const consumption = {
      kind: 'consumption' as const,
      input: 1,
      output: 1,
      total: 2
    }
    expect(tokenUsageSchema.safeParse({ ...consumption, input: -1 }).success).toBe(false)
    expect(tokenUsageSchema.safeParse({ ...consumption, output: 1.5 }).success).toBe(false)
    expect(tokenUsageSchema.safeParse({ kind: 'context', used: -1 }).success).toBe(false)
    expect(tokenUsageSchema.safeParse({ kind: 'context', used: 1.2 }).success).toBe(false)
    expect(tokenUsageSchema.safeParse({ ...consumption, guessed: 9 }).success).toBe(false)
    expect(tokenUsageSchema.safeParse({ kind: 'context', used: 1, extra: true }).success).toBe(
      false
    )
    expect(tokenUsageSchema.safeParse({ kind: 'guess', total: 1 }).success).toBe(false)
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

  it('carries optional choices on agent_question and user_question', () => {
    expect(
      agentEventPayloadSchema.parse({
        type: 'agent_question',
        ...identity,
        questionId: 'q1',
        question: 'which db?',
        choices: ['Postgres', 'SQLite']
      })
    ).toMatchObject({ choices: ['Postgres', 'SQLite'] })
    expect(
      agentEventPayloadSchema.parse({
        type: 'user_question',
        questionId: 'q-u',
        question: 'Ship it?',
        choices: ['Yes', 'No']
      })
    ).toMatchObject({ choices: ['Yes', 'No'] })
    expect(
      agentEventPayloadSchema.parse({
        type: 'user_question',
        questionId: 'q-u',
        question: 'Ship it?'
      })
    ).not.toHaveProperty('choices')
  })
})
