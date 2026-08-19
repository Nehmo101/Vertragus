import { describe, expect, it } from 'vitest'
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

  it('attaches host worktree facts to agent_done', async () => {
    const { runtime, tools, agentId } = await setup()
    runtime.host.snapshots.set(agentId, {
      branch: 'vertragus/arsenale/caronte',
      headSha: 'cccccccccccccccccccccccccccccccccccccccc',
      uncommitted: true,
      changedFiles: ['src/parser.ts'],
      diffStat: ' src/parser.ts | 4 +++-\n'
    })

    await callTool(tools, 'report_done', { summary: 'parser fixed' })
    expect(runtime.events.all().at(-1)).toMatchObject({
      type: 'agent_done',
      agentId,
      summary: 'parser fixed',
      branch: 'vertragus/arsenale/caronte',
      headSha: 'cccccccccccccccccccccccccccccccccccccccc',
      uncommitted: true,
      changedFiles: ['src/parser.ts']
    })
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

describe('report_progress', () => {
  it('pushes agent_progress', async () => {
    const { runtime, tools } = await setup()
    await callTool(tools, 'report_progress', { note: 'schema written' })
    expect(runtime.events.all().at(-1)).toMatchObject({
      type: 'agent_progress',
      note: 'schema written'
    })
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

  it('stays below the 60 s MCP request timeout by default', () => {
    expect(ASK_TIMEOUT_DEFAULT_MS).toBeLessThan(60_000)
  })
})
