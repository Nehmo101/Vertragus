import { describe, expect, it, vi } from 'vitest'
import {
  ASK_TIMEOUT_DEFAULT_MS,
  registerSubagentTools,
  resolveAskTimeoutMs,
  SUBAGENT_TOOL_NAMES
} from './toolsSubagent'
import { callTool, captureTools, FakeAgentHost, fakeRuntime } from './testing'
import type { AgentEvent } from '@shared/schema/events'

async function setup(askTimeoutMs = 50) {
  const runtime = fakeRuntime({ askTimeoutMs })
  const started = runtime.host.beginAgent({ role: 'worker', task: 't' })
  const tools = captureTools((server) => registerSubagentTools(server, runtime, started.agentId))
  return { runtime, tools, agentId: started.agentId, name: started.name }
}

function questionEvents(events: AgentEvent[]): AgentEvent[] {
  return events.filter((event) => event.type === 'agent_question')
}

describe('subagent tool surface', () => {
  it('registers exactly the three reporting tools — nothing that starts agents', async () => {
    const { tools } = await setup()
    expect([...tools.keys()].sort()).toEqual([...SUBAGENT_TOOL_NAMES].sort())
    expect(tools.has('start_agent')).toBe(false)
    expect(tools.has('await_events')).toBe(false)
  })
})

describe('report_done', () => {
  it('pushes agent_done with the agent identity and defaults to success', async () => {
    const { runtime, tools, agentId, name } = await setup()
    const result = await callTool(tools, 'report_done', { summary: 'parser fixed, tests green' })

    expect(result.json.ok).toBe(true)
    expect(runtime.events.all().at(-1)).toMatchObject({
      type: 'agent_done',
      agentId,
      name,
      roleId: 'worker',
      status: 'success',
      summary: 'parser fixed, tests green'
    })
  })

  it('keeps a blocked status as reported', async () => {
    const { runtime, tools } = await setup()
    await callTool(tools, 'report_done', { summary: 'need credentials', status: 'blocked' })
    expect(runtime.events.all().at(-1)).toMatchObject({ status: 'blocked' })
  })

  it('A3: hands the report to the host’s adoption automation, with its status', async () => {
    const { runtime, tools, agentId } = await setup()
    await callTool(tools, 'report_done', { summary: 'parser fixed', status: 'blocked' })
    await vi.waitFor(() => expect(runtime.host.adopted).toHaveLength(1))
    expect(runtime.host.adopted[0]).toEqual({ agentId, status: 'blocked' })
  })

  it('rejects an invented status at the schema', async () => {
    const { tools } = await setup()
    await expect(callTool(tools, 'report_done', { summary: 's', status: 'kinda' })).rejects.toThrow()
  })

  it('may be called again for a follow-up task', async () => {
    const { runtime, tools } = await setup()
    await callTool(tools, 'report_done', { summary: 'first' })
    await callTool(tools, 'report_done', { summary: 'second' })
    expect(runtime.events.all().filter((e) => e.type === 'agent_done')).toHaveLength(2)
  })

  it('tells the agent to stay available instead of exiting', async () => {
    const { tools } = await setup()
    const result = await callTool(tools, 'report_done', { summary: 's' })
    expect(String(result.json.note)).toMatch(/do not exit/i)
  })

  it('attaches host worktree facts to agent_done via the C3 done-snapshot', async () => {
    const { runtime, tools, agentId } = await setup()
    runtime.host.snapshots.set(agentId, {
      branch: 'vertragus/arsenale/caronte',
      headSha: 'cccccccccccccccccccccccccccccccccccccccc',
      uncommitted: true,
      changedFiles: ['src/parser.ts'],
      diffStat: ' src/parser.ts | 4 +++-\n'
    })

    await callTool(tools, 'report_done', { summary: 'parser fixed' })
    // The host committed the dirty worktree (C3): uncommitted flips to false,
    // HEAD moves, and the change set of THIS done stays on the event.
    expect(runtime.events.all().at(-1)).toMatchObject({
      type: 'agent_done',
      agentId,
      summary: 'parser fixed',
      branch: 'vertragus/arsenale/caronte',
      uncommitted: false,
      changedFiles: ['src/parser.ts']
    })
    // The tool hands the summary to the host — it becomes the commit subject.
    expect(runtime.host.doneSnapshots).toEqual([{ agentId, summary: 'parser fixed' }])
  })

  it('S4: lands as lastReport on the agent’s board tasks — status untouched', async () => {
    const { runtime, tools, agentId } = await setup()
    const board = runtime.taskBoard!
    board.create({ subject: 'Mine', ownerAgentId: agentId })
    board.create({ subject: 'Not mine', ownerAgentId: 'someone-else' })

    await callTool(tools, 'report_done', { summary: 'parser fixed', status: 'success' })
    const mine = board.get('task-1')!
    expect(mine.lastReport).toMatchObject({ status: 'success', summary: 'parser fixed' })
    // The C3 snapshot's HEAD rides along as a host fact.
    expect(mine.lastReport?.headSha).toBeTruthy()
    // Verification stays the orchestrator's explicit decision — never here.
    expect(mine.status).toBe('in_progress')
    expect(board.get('task-2')?.lastReport).toBeUndefined()
  })

  it('S4: notes the report even when the worktree snapshot fails (no headSha then)', async () => {
    const runtime = fakeRuntime({ host: new FakeAgentHost({ snapshotError: 'git died' }) })
    const started = runtime.host.beginAgent({ role: 'worker', task: 't' })
    const tools = captureTools((server) => registerSubagentTools(server, runtime, started.agentId))
    runtime.taskBoard!.create({ subject: 'Mine', ownerAgentId: started.agentId })

    await callTool(tools, 'report_done', { summary: 'done anyway' })
    const task = runtime.taskBoard!.get('task-1')!
    expect(task.lastReport).toEqual({ status: 'success', summary: 'done anyway' })
  })

  it('still reports done when the worktree snapshot fails', async () => {
    const runtime = fakeRuntime({ host: new FakeAgentHost({ snapshotError: 'git died' }) })
    const started = runtime.host.beginAgent({ role: 'worker', task: 't' })
    const tools = captureTools((server) => registerSubagentTools(server, runtime, started.agentId))

    const result = await callTool(tools, 'report_done', { summary: 'tried' })
    expect(result.json.ok).toBe(true)
    expect(runtime.events.all().at(-1)).toMatchObject({
      type: 'agent_done',
      summary: 'tried',
      status: 'success'
    })
    expect(runtime.events.all().at(-1)).not.toHaveProperty('uncommitted')
  })
})

describe('report_done — S3 structured results', () => {
  const schema = {
    type: 'object' as const,
    required: ['pass', 'failures'],
    additionalProperties: false,
    properties: {
      pass: { type: 'boolean' as const },
      failures: { type: 'array' as const, items: { type: 'string' as const } }
    }
  }

  it('stays unchanged without a registered schema — no result required, none delivered', async () => {
    const { runtime, tools } = await setup()
    const result = await callTool(tools, 'report_done', { summary: 'done' })
    expect(result.json.ok).toBe(true)
    expect(runtime.events.all().at(-1)).not.toHaveProperty('result')
  })

  it('without a schema, an offered result is passed through honestly, not dropped', async () => {
    const { runtime, tools } = await setup()
    await callTool(tools, 'report_done', { summary: 'done', result: { pass: true } })
    expect(runtime.events.all().at(-1)).toMatchObject({ result: { pass: true } })
  })

  it('with a schema, a missing result is an error and NO agent_done is pushed', async () => {
    const { runtime, tools, agentId } = await setup()
    runtime.resultSchemas.set(agentId, schema)
    const result = await callTool(tools, 'report_done', { summary: 'done' })
    expect(result.isError).toBe(true)
    expect(result.json.error).toBe('invalid_result')
    expect((result.json.problems as string[])[0]).toContain('result: missing')
    expect(String(result.json.note)).toContain('NOT delivered')
    expect(runtime.events.all().filter((event) => event.type === 'agent_done')).toHaveLength(0)
  })

  it('with a schema, an invalid result names the wrong paths and pushes nothing', async () => {
    const { runtime, tools, agentId } = await setup()
    runtime.resultSchemas.set(agentId, schema)
    const result = await callTool(tools, 'report_done', {
      summary: 'done',
      result: { pass: 'yes', failures: ['a', 2] }
    })
    expect(result.isError).toBe(true)
    expect(result.json.problems).toEqual([
      'result.pass: expected boolean, got string',
      'result.failures[1]: expected string, got number'
    ])
    expect(runtime.events.all().filter((event) => event.type === 'agent_done')).toHaveLength(0)
  })

  it('a valid result rides the agent_done event — the retry loop ends at the child', async () => {
    const { runtime, tools, agentId } = await setup()
    runtime.resultSchemas.set(agentId, schema)
    const result = await callTool(tools, 'report_done', {
      summary: 'tests run',
      result: { pass: false, failures: ['login flow red'] }
    })
    expect(result.isError).toBe(false)
    expect(runtime.events.all().at(-1)).toMatchObject({
      type: 'agent_done',
      summary: 'tests run',
      result: { pass: false, failures: ['login flow red'] }
    })
  })

  it('caps the serialized result size — with and without a schema', async () => {
    const { runtime, tools, agentId } = await setup()
    const huge = { pass: true, failures: ['x'.repeat(9_000)] }
    // No schema: too large is an error, never a silent drop.
    const bare = await callTool(tools, 'report_done', { summary: 's', result: huge })
    expect(bare.isError).toBe(true)
    expect(bare.json.error).toBe('invalid_result')
    expect(String((bare.json.problems as string[])[0])).toContain('8000')
    // With a schema the same cap applies on top of validation.
    runtime.resultSchemas.set(agentId, schema)
    const typed = await callTool(tools, 'report_done', { summary: 's', result: huge })
    expect(typed.isError).toBe(true)
    expect(runtime.events.all().filter((event) => event.type === 'agent_done')).toHaveLength(0)
  })
})

describe('report_progress', () => {
  it('pushes agent_progress as a quiet event — a milestone note never needs a reaction', async () => {
    const { runtime, tools } = await setup()
    // S2: a parked orchestrator loop must sleep through the note and read it
    // with its next wake instead of spending a model turn on it.
    const parked = runtime.events.wait(runtime.events.cursor, 5_000)
    await callTool(tools, 'report_progress', { note: 'schema written' })
    expect(runtime.events.waiterCount).toBe(1)
    expect(runtime.events.all().at(-1)).toMatchObject({
      type: 'agent_progress',
      note: 'schema written',
      quiet: true
    })
    runtime.events.close()
    expect((await parked).map((event) => event.type)).toEqual(['agent_progress'])
  })

  it('caps the note length at the schema', async () => {
    const { tools } = await setup()
    await expect(callTool(tools, 'report_progress', { note: 'x'.repeat(501) })).rejects.toThrow()
  })
})

describe('ask_orchestrator', () => {
  it('blocks until the orchestrator answers and emits exactly one question event', async () => {
    const { runtime, tools, agentId } = await setup(5_000)
    const pending = callTool(tools, 'ask_orchestrator', { question: 'zod or valibot?' })

    // Let the tool register its question before answering it.
    await new Promise((resolve) => setTimeout(resolve, 10))
    const open = runtime.questions.openForAgent(agentId)!
    expect(open.question).toBe('zod or valibot?')
    runtime.questions.answer(open.questionId, 'zod')

    const result = await pending
    expect(result.json).toMatchObject({ answer: 'zod', ticket: open.questionId })
    expect(questionEvents(runtime.events.all())).toHaveLength(1)
  })

  it('hands out a ticket on timeout and tells the agent not to rephrase', async () => {
    const { runtime, tools, agentId } = await setup(20)
    const result = await callTool(tools, 'ask_orchestrator', { question: 'which db?' })

    expect(result.json.answer).toBeNull()
    expect(result.json.ticket).toBe(runtime.questions.openForAgent(agentId)!.questionId)
    expect(String(result.json.note)).toMatch(/do not rephrase/i)
  })

  it('resumes the SAME question with a ticket — no second question event', async () => {
    const { runtime, tools } = await setup(20)
    const first = await callTool(tools, 'ask_orchestrator', { question: 'which db?' })
    const ticket = String(first.json.ticket)

    const second = callTool(tools, 'ask_orchestrator', { question: 'which db?', ticket })
    await new Promise((resolve) => setTimeout(resolve, 5))
    runtime.questions.answer(ticket, 'postgres')

    expect((await second).json).toMatchObject({ answer: 'postgres', ticket })
    expect(questionEvents(runtime.events.all())).toHaveLength(1)
  })

  it('still returns the answer when it arrived between timeout and resume', async () => {
    const { runtime, tools } = await setup(20)
    const first = await callTool(tools, 'ask_orchestrator', { question: 'which db?' })
    const ticket = String(first.json.ticket)
    runtime.questions.answer(ticket, 'sqlite')

    const second = await callTool(tools, 'ask_orchestrator', { question: 'which db?', ticket })
    expect(second.json).toMatchObject({ answer: 'sqlite' })
    expect(questionEvents(runtime.events.all())).toHaveLength(1)
  })

  it('reuses the open question when the agent asks again without a ticket', async () => {
    const { runtime, tools } = await setup(20)
    await callTool(tools, 'ask_orchestrator', { question: 'which db?' })
    await callTool(tools, 'ask_orchestrator', { question: 'seriously, which db?' })

    expect(runtime.questions.openCount).toBe(1)
    expect(questionEvents(runtime.events.all())).toHaveLength(1)
  })

  it('errors on a ticket that is not its own', async () => {
    const { runtime, tools } = await setup(20)
    const foreign = runtime.questions.create('other-agent', 'not yours')
    const result = await callTool(tools, 'ask_orchestrator', {
      question: 'q?',
      ticket: foreign.questionId
    })
    expect(result.isError).toBe(true)
    expect(result.json).toMatchObject({ error: 'unknown_ticket' })
  })

  it('stops waiting when the question is cancelled', async () => {
    const { runtime, tools, agentId } = await setup(5_000)
    const pending = callTool(tools, 'ask_orchestrator', { question: 'q?' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    runtime.questions.cancelForAgent(agentId)

    const result = await pending
    expect(result.json).toMatchObject({ answer: null, ticket: null })
    expect(String(result.json.note)).toMatch(/stop waiting/i)
  })
})

describe('resolveAskTimeoutMs', () => {
  it('prefers the workspace option', () => {
    expect(resolveAskTimeoutMs(1_234, { VERTRAGUS_ASK_TIMEOUT_MS: '99' })).toBe(1_234)
  })

  it('falls back to the environment override', () => {
    expect(resolveAskTimeoutMs(undefined, { VERTRAGUS_ASK_TIMEOUT_MS: '250' })).toBe(250)
  })

  it('ignores nonsense and uses the 50 s default', () => {
    expect(resolveAskTimeoutMs(undefined, {})).toBe(ASK_TIMEOUT_DEFAULT_MS)
    expect(resolveAskTimeoutMs(0, { VERTRAGUS_ASK_TIMEOUT_MS: 'soon' })).toBe(ASK_TIMEOUT_DEFAULT_MS)
    expect(resolveAskTimeoutMs(undefined, { VERTRAGUS_ASK_TIMEOUT_MS: '-5' })).toBe(
      ASK_TIMEOUT_DEFAULT_MS
    )
  })

  it('uses the caller raised window over the default, but never over option or env', () => {
    expect(resolveAskTimeoutMs(undefined, {}, 570_000)).toBe(570_000)
    // The harness env override must keep forcing the ticket path even for a
    // provider with a raised claim — otherwise tickets become untestable.
    expect(resolveAskTimeoutMs(undefined, { VERTRAGUS_ASK_TIMEOUT_MS: '250' }, 570_000)).toBe(250)
    expect(resolveAskTimeoutMs(1_234, {}, 570_000)).toBe(1_234)
    // A nonsense raised window falls through to the default instead of hanging.
    expect(resolveAskTimeoutMs(undefined, {}, 0)).toBe(ASK_TIMEOUT_DEFAULT_MS)
    expect(resolveAskTimeoutMs(undefined, {}, Number.NaN)).toBe(ASK_TIMEOUT_DEFAULT_MS)
  })

  it('stays below the 60 s MCP request timeout by default', () => {
    expect(ASK_TIMEOUT_DEFAULT_MS).toBeLessThan(60_000)
  })
})

describe('ask_orchestrator raised window', () => {
  it('blocks per the host-declared per-agent window when the workspace sets none', async () => {
    // No workspace askTimeoutMs — the raised window is the only thing keeping
    // this test from the 50 s default, so its resolution is observable.
    const runtime = fakeRuntime({})
    const started = runtime.host.beginAgent({ role: 'worker', task: 't' })
    runtime.host.askWindows.set(started.agentId, 30)
    const tools = captureTools((server) =>
      registerSubagentTools(server, runtime, started.agentId)
    )

    const begun = Date.now()
    const result = await callTool(tools, 'ask_orchestrator', { question: 'which db?' })
    expect(Date.now() - begun).toBeLessThan(5_000)
    expect(result.json.answer).toBeNull()
    expect(result.json.ticket).toBeTruthy()
  })
})
