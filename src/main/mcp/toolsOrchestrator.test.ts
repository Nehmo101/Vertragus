import { describe, expect, it, vi } from 'vitest'
import { CONTRACT_MARKER, HANDOFF_MARKER } from '@shared/prompts/contract'
import { ORCHESTRATOR_TOOL_NAMES, registerOrchestratorTools } from './toolsOrchestrator'
import { adoptSubtree, queueForAgent } from './types'
import { callTool, captureTools, FakeAgentHost, fakeRuntime } from './testing'

function setup(options: Parameters<typeof fakeRuntime>[0] = {}) {
  const runtime = fakeRuntime(options)
  const tools = captureTools((server) => registerOrchestratorTools(server, runtime))
  return { runtime, tools }
}

describe('orchestrator tool surface', () => {
  it('registers exactly the documented tools', () => {
    const { tools } = setup()
    expect([...tools.keys()].sort()).toEqual([...ORCHESTRATOR_TOOL_NAMES].sort())
  })

  it('describes every tool for the model', () => {
    const { tools } = setup()
    for (const tool of tools.values()) expect(tool.description?.length ?? 0).toBeGreaterThan(40)
  })
})

describe('ask_user — D3', () => {
  it('parks a question for the human, pushes user_question once, and resumes by ticket', async () => {
    const { runtime, tools } = setup()

    // First call times out (nobody answered) and hands out a ticket.
    runtime.ctx.askTimeoutMs = 10
    const first = await callTool(tools, 'ask_user', { question: 'Ship v1 without dark mode?' })
    expect(first.json.answer).toBeNull()
    const ticket = String(first.json.ticket)
    expect(ticket).toBeTruthy()

    const events = runtime.events.all().filter((event) => event.type === 'user_question')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ questionId: ticket, question: 'Ship v1 without dark mode?' })

    // A repeated ask without a ticket reuses the SAME open question — one
    // blocking prompt for the human, not a pile.
    const repeat = await callTool(tools, 'ask_user', { question: 'Ship v1 without dark mode?' })
    expect(repeat.json.ticket).toBe(ticket)
    expect(runtime.events.all().filter((event) => event.type === 'user_question')).toHaveLength(1)

    // The panel/gateway answers under the reserved agent id `user` (H1 path);
    // the ticket resume then delivers it.
    runtime.questions.answer(ticket, 'Yes, ship it.')
    const resumed = await callTool(tools, 'ask_user', { question: 'unchanged', ticket })
    expect(resumed.json).toMatchObject({ answer: 'Yes, ship it.', ticket })
  })

  it('blocks per the raised orchestrator window instead of the 50 s ticket carousel', async () => {
    // awaitTimeout is the orchestrator CLI's raised window — ask_user runs on
    // that same CLI, so with no explicit askTimeoutMs the call must block
    // maxSec (here 1 s), not the 50 s default (which would fail this test).
    const { tools } = setup({ awaitTimeout: { defaultSec: 1, maxSec: 1 } })
    const begun = Date.now()
    const first = await callTool(tools, 'ask_user', { question: 'Q?' })
    expect(Date.now() - begun).toBeLessThan(5_000)
    expect(first.json.answer).toBeNull()
    expect(first.json.ticket).toBeTruthy()
  })

  it('answers immediately when the user is faster than the timeout', async () => {
    const { runtime, tools } = setup()
    runtime.ctx.askTimeoutMs = 5_000
    const pending = callTool(tools, 'ask_user', { question: 'Which name?' })
    await vi.waitFor(() => {
      expect(runtime.questions.openForAgent('user')).toBeTruthy()
    })
    const open = runtime.questions.openForAgent('user')!
    runtime.questions.answer(open.questionId, 'Vertragus.')
    expect((await pending).json).toMatchObject({ answer: 'Vertragus.' })
  })

  it('send_to_agent cannot answer the user’s question by accident', async () => {
    const { runtime, tools } = setup()
    runtime.ctx.askTimeoutMs = 10
    const first = await callTool(tools, 'ask_user', { question: 'Q?' })
    const ticket = String(first.json.ticket)

    const wrong = await callTool(tools, 'send_to_agent', {
      agentId: 'agent-1',
      text: 'answer',
      questionId: ticket
    })
    expect(wrong.isError).toBe(true)
    expect(wrong.json.error).toBe('question_agent_mismatch')
    expect(runtime.questions.openForAgent('user')?.questionId).toBe(ticket)
  })
})

describe('C5 idle-watchdog touch', () => {
  it('every tool call touches the runtime hook on entry AND exit', async () => {
    const { runtime, tools } = setup()
    let touches = 0
    runtime.onOrchestratorToolCall = () => {
      touches += 1
    }

    await callTool(tools, 'list_agents', {})
    expect(touches).toBe(2)

    await callTool(tools, 'start_agent', { role: 'worker', task: 't' })
    expect(touches).toBe(4)

    // Errors touch too — a refused call is still activity.
    await callTool(tools, 'start_agent', { role: 'ghost', task: 't' })
    expect(touches).toBe(6)
  })
})

describe('start_agent', () => {
  it('starts the agent, appends the contract and pushes agent_started', async () => {
    const { runtime, tools } = setup()
    const result = await callTool(tools, 'start_agent', { role: 'worker', task: 'Fix the parser' })

    expect(result.isError).toBe(false)
    expect(result.json.agentId).toBe('agent-1')
    const seeded = runtime.host.seeded[0]!
    expect(seeded.task).toContain('Fix the parser')
    expect(seeded.task).toContain(CONTRACT_MARKER)
    expect(seeded.task).toContain('report_done')

    const events = runtime.events.all()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'agent_started', agentId: 'agent-1', roleId: 'worker' })
  })

  it('D4: appends the approval rule only under the ask-orchestrator tier', async () => {
    const gated = setup()
    gated.runtime.ctx.agentPolicy = 'ask-orchestrator'
    await callTool(gated.tools, 'start_agent', { role: 'worker', task: 't' })
    expect(gated.runtime.host.seeded[0]!.task).toContain(
      'call ask_orchestrator and wait for the approval'
    )

    // The other tiers (and a context without the field) keep the contract as-is.
    const plain = setup()
    plain.runtime.ctx.agentPolicy = 'ask-user'
    await callTool(plain.tools, 'start_agent', { role: 'worker', task: 't' })
    expect(plain.runtime.host.seeded[0]!.task).not.toContain('approval')
  })

  it('passes the model through and reports the agent’s own worktree and branch back', async () => {
    const { runtime, tools } = setup()
    const result = await callTool(tools, 'start_agent', {
      role: 'worker',
      task: 't',
      model: 'opus'
    })
    // Isolation is unconditional — there is no worktree flag to set or forget.
    expect(result.json.worktreePath).toBe('/tmp/worktrees/agent-1')
    expect(result.json.branch).toBe('vertragus/arsenale/agent-1')
    expect(runtime.events.all()[0]).toMatchObject({
      model: 'opus',
      worktreePath: '/tmp/worktrees/agent-1',
      branch: 'vertragus/arsenale/agent-1'
    })
  })

  it('hands baseBranch to the host so an agent can build on another’s branch', async () => {
    const baseBranches: Array<string | undefined> = []
    const host = new FakeAgentHost({ onStart: (input) => baseBranches.push(input.baseBranch) })
    const { tools } = setup({ host })

    await callTool(tools, 'start_agent', { role: 'worker', task: 't' })
    await callTool(tools, 'start_agent', {
      role: 'reviewer',
      task: 't',
      baseBranch: 'vertragus/arsenale/agent-1'
    })

    expect(baseBranches).toEqual([undefined, 'vertragus/arsenale/agent-1'])
  })

  it('Track 4: hands slotId and providerId through to the host untouched', async () => {
    const choices: Array<{ slotId?: string; providerId?: string }> = []
    const host = new FakeAgentHost({
      onStart: (input) => choices.push({ slotId: input.slotId, providerId: input.providerId })
    })
    const { tools } = setup({ host })

    await callTool(tools, 'start_agent', { role: 'worker', task: 't', providerId: 'codex' })
    await callTool(tools, 'start_agent', { role: 'worker', task: 't', slotId: 'slot-2' })

    expect(choices).toEqual([
      { slotId: undefined, providerId: 'codex' },
      { slotId: 'slot-2', providerId: undefined }
    ])
  })

  it('C4: a baseBranch with a reported done gets a handoff block between task and contract', async () => {
    const { runtime, tools } = setup()
    runtime.events.push({
      type: 'agent_done',
      agentId: 'agent-0',
      name: 'Caronte',
      roleId: 'worker',
      summary: 'Rewired the parser and ran the tests.',
      status: 'success',
      branch: 'vertragus/arsenale/agent-0',
      headSha: 'cafebabe',
      uncommitted: false,
      changedFiles: ['src/parser.ts', 'src/parser.test.ts'],
      diffStat: '2 files changed'
    })
    // A later done on the SAME branch supersedes the earlier one.
    runtime.events.push({
      type: 'agent_done',
      agentId: 'agent-0',
      name: 'Caronte',
      roleId: 'worker',
      summary: 'Fixed the review findings.',
      status: 'success',
      branch: 'vertragus/arsenale/agent-0',
      headSha: 'deadbeef',
      changedFiles: ['src/parser.ts']
    })

    await callTool(tools, 'start_agent', {
      role: 'reviewer',
      task: 'Review the parser work.',
      baseBranch: 'vertragus/arsenale/agent-0'
    })

    const seeded = runtime.host.seeded[0]!.task
    expect(seeded).toContain(HANDOFF_MARKER)
    expect(seeded).toContain('Caronte (worker)')
    expect(seeded).toContain('Fixed the review findings.')
    expect(seeded).toContain('deadbeef')
    expect(seeded).not.toContain('Rewired the parser')
    // Order: task, then handoff, then contract.
    expect(seeded.indexOf('Review the parser work.')).toBeLessThan(seeded.indexOf(HANDOFF_MARKER))
    expect(seeded.indexOf(HANDOFF_MARKER)).toBeLessThan(seeded.indexOf(CONTRACT_MARKER))
  })

  it('C4: no handoff without a matching done — and none without baseBranch', async () => {
    const { runtime, tools } = setup()
    runtime.events.push({
      type: 'agent_done',
      agentId: 'agent-0',
      name: 'Caronte',
      roleId: 'worker',
      summary: 'Other work.',
      status: 'success',
      branch: 'vertragus/arsenale/other'
    })

    await callTool(tools, 'start_agent', { role: 'worker', task: 'Fresh work.' })
    await callTool(tools, 'start_agent', {
      role: 'reviewer',
      task: 'Review.',
      baseBranch: 'vertragus/arsenale/agent-ghost'
    })

    expect(runtime.host.seeded[0]!.task).not.toContain(HANDOFF_MARKER)
    expect(runtime.host.seeded[1]!.task).not.toContain(HANDOFF_MARKER)
  })

  it('rejects an unknown role and names the valid ones', async () => {
    const { runtime, tools } = setup({ roles: ['worker'] })
    const result = await callTool(tools, 'start_agent', { role: 'designer', task: 't' })
    expect(result.isError).toBe(true)
    expect(result.json).toMatchObject({ error: 'unknown_role', availableRoles: ['worker'] })
    expect(runtime.host.agents.size).toBe(0)
  })

  it('enforces the per-role limit with concrete numbers', async () => {
    const { tools } = setup({ roles: ['worker'], perRole: { worker: 1 } })
    await callTool(tools, 'start_agent', { role: 'worker', task: 't' })
    const result = await callTool(tools, 'start_agent', { role: 'worker', task: 't' })

    expect(result.isError).toBe(true)
    expect(result.json).toMatchObject({
      error: 'limit_exceeded',
      scope: 'role',
      role: 'worker',
      running: 1,
      max: 1
    })
  })

  it('treats an undefined per-role entry as "no limit"', async () => {
    const { tools } = setup({ roles: ['worker'], perRole: { worker: undefined } })
    for (let i = 0; i < 3; i++) {
      expect((await callTool(tools, 'start_agent', { role: 'worker', task: 't' })).isError).toBe(false)
    }
  })

  it('enforces the workspace total across roles', async () => {
    const { tools } = setup({ roles: ['worker', 'reviewer'], maxTotal: 2 })
    await callTool(tools, 'start_agent', { role: 'worker', task: 't' })
    await callTool(tools, 'start_agent', { role: 'reviewer', task: 't' })
    const result = await callTool(tools, 'start_agent', { role: 'worker', task: 't' })

    expect(result.json).toMatchObject({
      error: 'limit_exceeded',
      scope: 'workspace',
      running: 2,
      max: 2
    })
  })

  it('frees a slot once an agent is stopped', async () => {
    const { tools } = setup({ roles: ['worker'], perRole: { worker: 1 } })
    const first = await callTool(tools, 'start_agent', { role: 'worker', task: 't' })
    await callTool(tools, 'stop_agent', { agentId: String(first.json.agentId) })
    expect((await callTool(tools, 'start_agent', { role: 'worker', task: 't' })).isError).toBe(false)
  })

  it('turns a host failure into a tool error instead of a crash', async () => {
    const runtime = fakeRuntime({ host: new FakeAgentHost({ startError: 'pty refused' }) })
    const tools = captureTools((server) => registerOrchestratorTools(server, runtime))
    const result = await callTool(tools, 'start_agent', { role: 'worker', task: 't' })
    expect(result.isError).toBe(true)
    expect(result.json).toMatchObject({ error: 'start_failed', message: 'pty refused' })
    expect(runtime.events.all()).toHaveLength(0)
    // A task that never started is not the workspace's current task.
    expect(runtime.latestTask).toBeUndefined()
  })

  it('records the first task line as the workspace\'s current task, shortened', async () => {
    const { runtime, tools } = setup()
    await callTool(tools, 'start_agent', {
      role: 'worker',
      task: '  Fix the parser\nDefinition of done: tests green'
    })
    expect(runtime.latestTask).toBe('Fix the parser')

    await callTool(tools, 'start_agent', { role: 'worker', task: `${'x'.repeat(200)}\nrest` })
    expect(runtime.latestTask).toHaveLength(140)
    expect(runtime.latestTask!.endsWith('…')).toBe(true)
  })

  it('records each agent\'s own current task and announces the change', async () => {
    const { runtime, tools } = setup()
    let notified = 0
    runtime.onTasksChanged = () => {
      notified += 1
    }

    await callTool(tools, 'start_agent', { role: 'worker', task: 'Fix the parser\ndetails' })
    await callTool(tools, 'start_agent', { role: 'reviewer', task: 'Review the parser fix' })

    expect(runtime.agentTasks.get('agent-1')).toBe('Fix the parser')
    expect(runtime.agentTasks.get('agent-2')).toBe('Review the parser fix')
    expect(notified).toBe(2)
  })
})

describe('send_to_agent', () => {
  async function withAgent(): Promise<{
    runtime: ReturnType<typeof fakeRuntime>
    tools: ReturnType<typeof captureTools>
    agentId: string
  }> {
    const { runtime, tools } = setup()
    const started = await callTool(tools, 'start_agent', { role: 'worker', task: 't' })
    return { runtime, tools, agentId: String(started.json.agentId) }
  }

  it('types the text into the PTY with a short contract reminder', async () => {
    const { runtime, tools, agentId } = await withAgent()
    const result = await callTool(tools, 'send_to_agent', { agentId, text: 'also update the docs' })

    expect(result.json).toMatchObject({ ok: true, delivered: 'message' })
    const sent = runtime.host.sent[0]!.text
    expect(sent).toContain('also update the docs')
    expect(sent).toContain('report_done')
  })

  it('uses the sentinel reminder when the agent reports via PTY lines', async () => {
    const host = new FakeAgentHost({ reportingMode: () => 'sentinel' })
    const runtime = fakeRuntime({ host })
    const tools = captureTools((server) => registerOrchestratorTools(server, runtime))
    const started = await callTool(tools, 'start_agent', { role: 'worker', task: 't' })
    expect(runtime.host.seeded[0]!.task).toContain('@@VERT')
    expect(runtime.host.seeded[0]!.task.replace(/\s+/g, '')).not.toMatch(/@@VERTRAGUS:/)

    await callTool(tools, 'send_to_agent', {
      agentId: String(started.json.agentId),
      text: 'follow up'
    })
    const sent = runtime.host.sent[0]!.text
    expect(sent).toContain('DONE sentinel')
    expect(sent).not.toContain('report_done')
  })

  it('makes a follow-up instruction the current task, but never a question answer', async () => {
    const { runtime, tools, agentId } = await withAgent()
    await callTool(tools, 'send_to_agent', { agentId, text: 'also update the docs' })
    expect(runtime.latestTask).toBe('also update the docs')
    // The agent's own note follows the follow-up — this is what the panel row
    // and the CLI window's hover card show for it.
    expect(runtime.agentTasks.get(agentId)).toBe('also update the docs')

    const question = runtime.questions.create(agentId, 'zod or valibot?')
    await callTool(tools, 'send_to_agent', {
      agentId,
      text: 'zod',
      questionId: question.questionId
    })
    expect(runtime.latestTask).toBe('also update the docs')
    expect(runtime.agentTasks.get(agentId)).toBe('also update the docs')
  })

  it('answers an open question instead of typing it', async () => {
    const { runtime, tools, agentId } = await withAgent()
    const question = runtime.questions.create(agentId, 'zod or valibot?')

    const result = await callTool(tools, 'send_to_agent', {
      agentId,
      text: 'zod',
      questionId: question.questionId
    })

    expect(result.json).toMatchObject({ ok: true, delivered: 'answer' })
    expect(runtime.host.sent).toHaveLength(0)
    expect(runtime.questions.openCount).toBe(0)
  })

  it('awaits deliverAnswer for sentinel questions and keeps exactly one reminder there', async () => {
    const { runtime, tools, agentId } = await withAgent()
    const question = runtime.questions.create(agentId, 'which file?', {
      deliverAnswer: async (answer) => {
        await runtime.host.sendToAgent(agentId, `${answer}\n\nSENTINEL_REMINDER`)
      }
    })

    const result = await callTool(tools, 'send_to_agent', {
      agentId,
      text: 'src/foo.ts',
      questionId: question.questionId
    })

    expect(result.json).toMatchObject({ ok: true, delivered: 'answer' })
    expect(runtime.host.sent).toEqual([
      { agentId, text: 'src/foo.ts\n\nSENTINEL_REMINDER' }
    ])
    expect(runtime.questions.openCount).toBe(0)
  })

  it('returns toolError when deliverAnswer fails and keeps the question open', async () => {
    const { runtime, tools, agentId } = await withAgent()
    let fail = true
    let delivered = ''
    const question = runtime.questions.create(agentId, 'which file?', {
      deliverAnswer: async (answer) => {
        if (fail) throw new Error('pty refused')
        delivered = answer
      }
    })

    const result = await callTool(tools, 'send_to_agent', {
      agentId,
      text: 'src/foo.ts',
      questionId: question.questionId
    })

    expect(result.isError).toBe(true)
    expect(result.json).toMatchObject({
      error: 'answer_delivery_failed',
      questionId: question.questionId,
      message: 'pty refused'
    })
    // Recoverable: question stays open; same questionId retries after the PTY accepts.
    expect(runtime.questions.openCount).toBe(1)
    expect(runtime.questions.get(question.questionId)?.question).toBe('which file?')
    expect(String((result.json as { note?: string }).note ?? '')).toMatch(/still open/i)

    fail = false
    const retry = await callTool(tools, 'send_to_agent', {
      agentId,
      text: 'src/foo.ts',
      questionId: question.questionId
    })
    expect(retry.isError).toBeFalsy()
    expect(delivered).toBe('src/foo.ts')
    expect(runtime.questions.openCount).toBe(0)
  })

  it('reports an unknown questionId instead of silently typing', async () => {
    const { tools, agentId } = await withAgent()
    const result = await callTool(tools, 'send_to_agent', {
      agentId,
      text: 'zod',
      questionId: 'nope'
    })
    expect(result.isError).toBe(true)
    expect(result.json).toMatchObject({ error: 'unknown_question' })
  })

  it('refuses to answer another agent question with the wrong agentId', async () => {
    const { runtime, tools, agentId } = await withAgent()
    const question = runtime.questions.create('someone-else', 'q?')
    const result = await callTool(tools, 'send_to_agent', {
      agentId,
      text: 'x',
      questionId: question.questionId
    })
    expect(result.json).toMatchObject({ error: 'question_agent_mismatch' })
    expect(runtime.questions.openCount).toBe(1)
  })

  it('warns when a plain message leaves a question unanswered', async () => {
    const { runtime, tools, agentId } = await withAgent()
    const question = runtime.questions.create(agentId, 'zod or valibot?')
    const result = await callTool(tools, 'send_to_agent', { agentId, text: 'keep going' })
    expect(result.json).toMatchObject({ openQuestionId: question.questionId })
  })

  it('turns a host failure into a tool error', async () => {
    const { tools } = setup()
    const result = await callTool(tools, 'send_to_agent', { agentId: 'ghost', text: 'hi' })
    expect(result.isError).toBe(true)
    expect(result.json).toMatchObject({ error: 'send_failed' })
  })
})

describe('await_events', () => {
  it('returns buffered events and advances the cursor', async () => {
    const { runtime, tools } = setup()
    await callTool(tools, 'start_agent', { role: 'worker', task: 't' })

    const result = await callTool(tools, 'await_events', { cursor: 0, timeoutSec: 1 })
    expect((result.json.events as unknown[]).length).toBe(1)
    expect(result.json.cursor).toBe(1)
    expect(result.json.note).toBeUndefined()
    expect(runtime.events.waiterCount).toBe(0)
  })

  it('keeps the cursor and demands a re-call when nothing happened', async () => {
    const { tools } = setup()
    await callTool(tools, 'start_agent', { role: 'worker', task: 't' })
    const result = await callTool(tools, 'await_events', { cursor: 7, timeoutSec: 1 })
    expect(result.json.events).toEqual([])
    expect(result.json.cursor).toBe(7)
    expect(String(result.json.note)).toMatch(/call await_events again/i)
    // Nothing happened, so nothing about the agents changed either — the empty
    // answer stays as small as the loop's most repeated result deserves.
    expect(result.json.agentsSummary).toBeUndefined()
  })

  it('answers in compact JSON — no pretty-printing anywhere in the loop', async () => {
    const { tools } = setup()
    await callTool(tools, 'start_agent', { role: 'worker', task: 't' })
    const result = await callTool(tools, 'await_events', { cursor: 0, timeoutSec: 1 })
    expect(result.text).not.toMatch(/\n/)
    expect(result.text.startsWith('{"events":[{')).toBe(true)
  })

  it('clamps the timeout to 55 s by rejecting anything larger', async () => {
    const { tools } = setup()
    await expect(callTool(tools, 'await_events', { timeoutSec: 900 })).rejects.toThrow()
  })

  it('honours an injected long-poll window for its default and its ceiling', async () => {
    // Small seconds so the assertion is a real wait and the suite stays fast.
    const { tools } = setup({ awaitTimeout: { defaultSec: 2, maxSec: 3 } })
    const timeout = tools.get('await_events')!.inputSchema.timeoutSec as {
      description?: string
    }
    expect(String(timeout.description)).toContain('default 2')
    expect(String(timeout.description)).toContain('max 3')

    // Above the injected ceiling the schema refuses — even though the built-in
    // fallback (55 s) would have accepted it.
    await expect(callTool(tools, 'await_events', { timeoutSec: 10 })).rejects.toThrow()

    // No timeoutSec at all blocks for the injected default, not the 50 s one.
    const started = Date.now()
    const result = await callTool(tools, 'await_events', { cursor: 0 })
    const elapsed = Date.now() - started
    expect(result.json.events).toEqual([])
    expect(elapsed).toBeGreaterThanOrEqual(1_800)
    expect(elapsed).toBeLessThan(3_000)
  })

  it('returns as soon as an event is pushed while it waits', async () => {
    const { runtime, tools } = setup()
    const pending = callTool(tools, 'await_events', { cursor: 0, timeoutSec: 5 })
    await Promise.resolve()
    runtime.events.push({
      type: 'agent_progress',
      agentId: 'a',
      name: 'A',
      roleId: 'worker',
      note: 'half way'
    })
    const result = await pending
    expect((result.json.events as Array<{ note: string }>)[0]!.note).toBe('half way')
  })

  it('includes the agent summary with the id needed to answer a question', async () => {
    const { runtime, tools } = setup()
    const started = await callTool(tools, 'start_agent', { role: 'worker', task: 't' })
    const agentId = String(started.json.agentId)
    const question = runtime.questions.create(agentId, 'which db?')

    const result = await callTool(tools, 'await_events', { cursor: 0, timeoutSec: 1 })
    const summary = result.json.agentsSummary as Array<Record<string, unknown>>
    expect(summary[0]).toMatchObject({
      agentId,
      pendingQuestion: 'which db?',
      pendingQuestionId: question.questionId
    })
  })

  it('drops the static per-agent fields from its summary rows', async () => {
    const { tools } = setup()
    await callTool(tools, 'start_agent', { role: 'worker', task: 't', model: 'opus' })

    const result = await callTool(tools, 'await_events', { cursor: 0, timeoutSec: 1 })
    const row = (result.json.agentsSummary as Array<Record<string, unknown>>)[0]!
    // Fixed at birth and already delivered by start_agent / agent_started —
    // repeating them every loop turn is pure token waste.
    expect(row).not.toHaveProperty('worktreePath')
    expect(row).not.toHaveProperty('model')
    expect(row).not.toHaveProperty('reporting')
    // What actually changes stays.
    expect(row).toMatchObject({ status: 'running', branch: expect.any(String) })
    expect(row).toHaveProperty('lastOutputAgeSec')

    // list_agents remains the full one-off overview.
    const listed = await callTool(tools, 'list_agents')
    expect((listed.json.agents as Array<Record<string, unknown>>)[0]).toMatchObject({
      model: 'opus',
      worktreePath: '/tmp/worktrees/agent-1',
      reporting: 'mcp'
    })
  })
})

describe('list_agents / stop_agent / read_output', () => {
  it('lists the agents of the workspace', async () => {
    const { tools } = setup()
    await callTool(tools, 'start_agent', { role: 'worker', task: 't' })
    const result = await callTool(tools, 'list_agents')
    expect((result.json.agents as unknown[]).length).toBe(1)
    expect(result.json.workspace).toBe('Arsenale')
  })

  it('stops an agent, pushes agent_stopped and drops its open question', async () => {
    const { runtime, tools } = setup()
    const started = await callTool(tools, 'start_agent', { role: 'worker', task: 't' })
    const agentId = String(started.json.agentId)
    runtime.questions.create(agentId, 'q?')

    const result = await callTool(tools, 'stop_agent', { agentId })
    expect(result.json.ok).toBe(true)
    expect(runtime.questions.openCount).toBe(0)
    expect(runtime.events.all().at(-1)).toMatchObject({ type: 'agent_stopped', agentId })
  })

  it('reports a no-op stop without inventing an event', async () => {
    const { runtime, tools } = setup()
    const result = await callTool(tools, 'stop_agent', { agentId: 'ghost' })
    expect(result.json.ok).toBe(false)
    expect(runtime.events.all()).toHaveLength(0)
  })

  it('returns the requested tail of the output', async () => {
    const { runtime, tools } = setup()
    const started = await callTool(tools, 'start_agent', { role: 'worker', task: 't' })
    const agentId = String(started.json.agentId)
    runtime.host.output.set(agentId, ['one', 'two', 'three'].join('\n'))

    const result = await callTool(tools, 'read_output', { agentId, lines: 2 })
    expect(result.text).toBe('two\nthree')
  })

  it('says so instead of returning an empty message', async () => {
    const { tools } = setup()
    const started = await callTool(tools, 'start_agent', { role: 'worker', task: 't' })
    const result = await callTool(tools, 'read_output', {
      agentId: String(started.json.agentId)
    })
    expect(result.text).toContain('no output')
  })

  it('rejects more than 400 lines at the schema', async () => {
    const { tools } = setup()
    await expect(callTool(tools, 'read_output', { agentId: 'a', lines: 4_000 })).rejects.toThrow()
  })

  it('turns a read failure into a tool error', async () => {
    const { tools } = setup()
    const result = await callTool(tools, 'read_output', { agentId: 'ghost' })
    expect(result.isError).toBe(true)
    expect(result.json).toMatchObject({ error: 'read_failed' })
  })
})

describe('inspect_agent', () => {
  it('returns host-truth facts from the agent worktree', async () => {
    const { runtime, tools } = setup()
    const started = await callTool(tools, 'start_agent', { role: 'worker', task: 't' })
    const agentId = String(started.json.agentId)
    runtime.host.snapshots.set(agentId, {
      branch: 'vertragus/arsenale/caronte',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      uncommitted: true,
      changedFiles: ['src/a.ts'],
      diffStat: ' src/a.ts | 2 +-\n'
    })

    const result = await callTool(tools, 'inspect_agent', { agentId, view: 'status' })
    expect(result.isError).toBe(false)
    expect(result.json).toMatchObject({
      agentId,
      view: 'status',
      branch: 'vertragus/arsenale/caronte',
      uncommitted: true,
      changedFiles: ['src/a.ts'],
      body: '(fake status)'
    })
  })

  it('refuses an agent that is still starting', async () => {
    const host = new FakeAgentHost()
    const begun = host.beginAgent({ role: 'worker', task: 't' })
    host.agents.set(begun.agentId, { ...host.agents.get(begun.agentId)!, status: 'starting' })
    const { tools } = setup({ host })

    const result = await callTool(tools, 'inspect_agent', { agentId: begun.agentId, view: 'diff' })
    expect(result.isError).toBe(true)
    expect(result.json).toMatchObject({ error: 'inspect_failed' })
    expect(String(result.json.message)).toMatch(/still starting/)
  })

  it('turns an unknown agent into a tool error', async () => {
    const { tools } = setup()
    const result = await callTool(tools, 'inspect_agent', { agentId: 'ghost', view: 'log' })
    expect(result.isError).toBe(true)
    expect(result.json).toMatchObject({ error: 'inspect_failed' })
  })

  it('requires a path for the file view', async () => {
    const { tools } = setup()
    const started = await callTool(tools, 'start_agent', { role: 'worker', task: 't' })
    const result = await callTool(tools, 'inspect_agent', {
      agentId: String(started.json.agentId),
      view: 'file'
    })
    expect(result.isError).toBe(true)
    expect(String(result.json.message)).toMatch(/needs path/)
  })

  it('rejects an invented view at the schema', async () => {
    const { tools } = setup()
    await expect(
      callTool(tools, 'inspect_agent', { agentId: 'a', view: 'blame' })
    ).rejects.toThrow()
  })
})

describe('record_retro', () => {
  function retroPort(): {
    port: { recordLearnings: ReturnType<typeof vi.fn>; recordSummary: ReturnType<typeof vi.fn> }
  } {
    return {
      port: {
        recordLearnings: vi.fn(() => ({ applied: 1 })),
        recordSummary: vi.fn()
      }
    }
  }

  it('answers retro_unavailable when the workspace records no retros', async () => {
    const { tools } = setup()
    const result = await callTool(tools, 'record_retro', { summary: 'Lief gut.' })
    expect(result.isError).toBe(true)
    expect(result.json.error).toBe('retro_unavailable')
  })

  it('rejects learnings for roles the workspace does not have', async () => {
    const { port } = retroPort()
    const { tools } = setup({ retro: port })
    const result = await callTool(tools, 'record_retro', {
      summary: 'Lief gut.',
      learnings: [{ role: 'wizard', kind: 'strength', insight: 'zaubert' }]
    })
    expect(result.isError).toBe(true)
    expect(result.json.error).toBe('unknown_role')
    expect(result.json.unknownRoles).toEqual(['wizard'])
    expect(port.recordSummary).not.toHaveBeenCalled()
    expect(port.recordLearnings).not.toHaveBeenCalled()
  })

  it('records summary and learnings and reports how many applied', async () => {
    const { port } = retroPort()
    const { tools } = setup({ retro: port })
    const result = await callTool(tools, 'record_retro', {
      summary: 'Beide Worker sauber, Review fand nichts.',
      learnings: [
        { role: 'worker', kind: 'strength', insight: 'stark bei UI', evidence: 'Task 1+2 grün' },
        { role: 'reviewer', kind: 'weakness', insight: 'langsam bei langen Diffs' }
      ]
    })
    expect(result.isError).toBe(false)
    expect(result.json.ok).toBe(true)
    expect(result.json.appliedLearnings).toBe(1)
    expect(port.recordSummary).toHaveBeenCalledWith('Beide Worker sauber, Review fand nichts.')
    expect(port.recordLearnings).toHaveBeenCalledWith([
      { role: 'worker', kind: 'strength', insight: 'stark bei UI', evidence: 'Task 1+2 grün' },
      { role: 'reviewer', kind: 'weakness', insight: 'langsam bei langen Diffs' }
    ])
  })

  it('accepts a summary without any learnings — empty slots are allowed', async () => {
    const { port } = retroPort()
    const { tools } = setup({ retro: port })
    const result = await callTool(tools, 'record_retro', { summary: 'Kein Befund.' })
    expect(result.isError).toBe(false)
    expect(port.recordLearnings).toHaveBeenCalledWith([])
  })
})

describe('multi-orchestration — F', () => {
  it('root registers eleven tools; a lead scope registers only the eight down-tools', () => {
    const { tools } = setup()
    expect([...tools.keys()].sort()).toEqual([...ORCHESTRATOR_TOOL_NAMES].sort())

    const runtime = fakeRuntime()
    const leadTools = captureTools((server) =>
      registerOrchestratorTools(server, runtime, { leadId: 'lead-1' })
    )
    expect([...leadTools.keys()].sort()).toEqual(
      ['start_agent', 'send_to_agent', 'await_events', 'list_agents', 'stop_agent', 'read_output', 'inspect_agent', 'integrate_branch'].sort()
    )
    // Depth 1 and root-only surface enforced by ABSENCE, not by prompt.
    expect(leadTools.has('start_orchestrator')).toBe(false)
    expect(leadTools.has('record_retro')).toBe(false)
    expect(leadTools.has('ask_user')).toBe(false)
  })

  it('start_orchestrator reserves a lead with its own queue and reports to the root queue', async () => {
    const { runtime, tools } = setup()
    const created: string[] = []
    runtime.onLeadCreated = (lead) => created.push(lead.agentId)

    const result = await callTool(tools, 'start_orchestrator', {
      area: 'payments',
      task: 'Own the payments rework.',
      maxSubagents: 2
    })

    expect(result.isError).toBe(false)
    const leadId = String(result.json.agentId)
    expect(result.json).toMatchObject({ area: 'payments', state: 'starting', maxSubagents: 2 })
    expect(runtime.leads.get(leadId)).toMatchObject({ area: 'payments', maxSubagents: 2 })
    expect(created).toEqual([leadId])
    // The lead itself is a direct child: its agent_started lands in the ROOT queue.
    await vi.waitFor(() => {
      expect(
        runtime.events.all().some((event) => event.type === 'agent_started' && event.agentId === leadId)
      ).toBe(true)
    })
    // The seed carried the lead contract.
    expect(runtime.host.seeded[0]!.task).toContain(CONTRACT_MARKER)
  })

  it('caps leads at MAX_LEADS and counts leads toward the global agent cap', async () => {
    const { tools } = setup()
    for (let index = 0; index < 4; index += 1) {
      const ok = await callTool(tools, 'start_orchestrator', { area: `a${index}`, task: 't' })
      expect(ok.isError).toBe(false)
    }
    const fifth = await callTool(tools, 'start_orchestrator', { area: 'a4', task: 't' })
    expect(fifth.isError).toBe(true)
    expect(fifth.json).toMatchObject({ error: 'limit_exceeded', scope: 'leads', max: 4 })

    // Global cap: fakeRuntime maxTotal defaults — check via a tight runtime.
    const tight = fakeRuntime({ maxTotal: 1 })
    const tightTools = captureTools((server) => registerOrchestratorTools(server, tight))
    await callTool(tightTools, 'start_orchestrator', { area: 'x', task: 't' })
    const over = await callTool(tightTools, 'start_orchestrator', { area: 'y', task: 't' })
    expect(over.isError).toBe(true)
    expect(over.json).toMatchObject({ error: 'limit_exceeded', scope: 'workspace' })
    const agentOver = await callTool(tightTools, 'start_agent', { role: 'worker', task: 't' })
    expect(agentOver.isError).toBe(true)
    expect(agentOver.json).toMatchObject({ error: 'limit_exceeded', scope: 'workspace' })
  })

  it('fan-in: a lead-started agent parents to the lead and its events bypass the root queue', async () => {
    const runtime = fakeRuntime()
    const rootTools = captureTools((server) => registerOrchestratorTools(server, runtime))
    await callTool(rootTools, 'start_orchestrator', { area: 'payments', task: 't' })
    const leadId = [...runtime.leads.keys()][0]!
    const lead = runtime.leads.get(leadId)!
    const leadTools = captureTools((server) =>
      registerOrchestratorTools(server, runtime, { leadId })
    )

    const started = await callTool(leadTools, 'start_agent', { role: 'worker', task: 'Do it.' })
    const childId = String(started.json.agentId)
    expect(runtime.parentOf.get(childId)).toBe(leadId)

    await vi.waitFor(() => {
      expect(
        lead.events.all().some((event) => event.type === 'agent_started' && event.agentId === childId)
      ).toBe(true)
    })
    // Grandchild events NEVER land in the root queue.
    expect(
      runtime.events.all().some((event) => event.type === 'agent_started' && event.agentId === childId)
    ).toBe(false)

    // The lead's own list shows only its subtree; the root's shows only the lead.
    const leadList = await callTool(leadTools, 'list_agents', {})
    expect((leadList.json.agents as Array<{ agentId: string }>).map((row) => row.agentId)).toEqual([
      childId
    ])
    const rootList = await callTool(rootTools, 'list_agents', {})
    const rootRows = rootList.json.agents as Array<{ agentId: string; childCount?: number }>
    expect(rootRows.map((row) => row.agentId)).toEqual([leadId])
    expect(rootRows[0]!.childCount).toBe(1)
  })

  it('enforces the subtree budget the root handed down', async () => {
    const runtime = fakeRuntime()
    const rootTools = captureTools((server) => registerOrchestratorTools(server, runtime))
    await callTool(rootTools, 'start_orchestrator', { area: 'x', task: 't', maxSubagents: 1 })
    const leadId = [...runtime.leads.keys()][0]!
    const leadTools = captureTools((server) =>
      registerOrchestratorTools(server, runtime, { leadId })
    )

    expect((await callTool(leadTools, 'start_agent', { role: 'worker', task: 't' })).isError).toBe(false)
    const over = await callTool(leadTools, 'start_agent', { role: 'worker', task: 't' })
    expect(over.isError).toBe(true)
    expect(over.json).toMatchObject({ error: 'limit_exceeded', scope: 'subtree', max: 1 })
  })

  it('fences every agent-addressing tool to the caller’s own subtree — no skip-level', async () => {
    const runtime = fakeRuntime()
    const rootTools = captureTools((server) => registerOrchestratorTools(server, runtime))
    // A root-started worker and a lead with one child.
    const rootChild = await callTool(rootTools, 'start_agent', { role: 'worker', task: 't' })
    const rootChildId = String(rootChild.json.agentId)
    await callTool(rootTools, 'start_orchestrator', { area: 'x', task: 't' })
    const leadId = [...runtime.leads.keys()][0]!
    const leadTools = captureTools((server) =>
      registerOrchestratorTools(server, runtime, { leadId })
    )
    const grandchild = await callTool(leadTools, 'start_agent', { role: 'worker', task: 't' })
    const grandchildId = String(grandchild.json.agentId)

    // Root cannot reach the grandchild…
    for (const [tool, args] of [
      ['send_to_agent', { agentId: grandchildId, text: 'x' }],
      ['stop_agent', { agentId: grandchildId }],
      ['read_output', { agentId: grandchildId }],
      ['inspect_agent', { agentId: grandchildId, view: 'status' }]
    ] as const) {
      const result = await callTool(rootTools, tool, args as Record<string, unknown>)
      expect(result.isError, `root ${tool}`).toBe(true)
      expect(result.json.error, `root ${tool}`).toBe('unknown_agent')
    }
    // …and the lead cannot reach the root's child.
    const wrong = await callTool(leadTools, 'send_to_agent', { agentId: rootChildId, text: 'x' })
    expect(wrong.isError).toBe(true)
    expect(wrong.json.error).toBe('unknown_agent')
    // In scope both directions still work.
    expect((await callTool(rootTools, 'send_to_agent', { agentId: rootChildId, text: 'x' })).isError).toBe(false)
    expect((await callTool(leadTools, 'send_to_agent', { agentId: grandchildId, text: 'x' })).isError).toBe(false)
  })

  it('adoptSubtree reparents children, closes the lead queue and tells the root once', async () => {
    const runtime = fakeRuntime()
    const rootTools = captureTools((server) => registerOrchestratorTools(server, runtime))
    await callTool(rootTools, 'start_orchestrator', { area: 'payments', task: 't' })
    const leadId = [...runtime.leads.keys()][0]!
    const lead = runtime.leads.get(leadId)!
    const leadTools = captureTools((server) =>
      registerOrchestratorTools(server, runtime, { leadId })
    )
    const child = await callTool(leadTools, 'start_agent', { role: 'worker', task: 't' })
    const childId = String(child.json.agentId)
    const parked = lead.events.wait(lead.events.cursor, 5_000)

    adoptSubtree(runtime, leadId)

    expect(runtime.leads.has(leadId)).toBe(false)
    expect(runtime.parentOf.has(childId)).toBe(false)
    expect(lead.events.isClosed).toBe(true)
    await expect(parked).resolves.toEqual([])
    const adopted = runtime.events.all().filter((event) => event.type === 'subtree_adopted')
    expect(adopted).toHaveLength(1)
    expect(adopted[0]).toMatchObject({
      leadAgentId: leadId,
      area: 'payments',
      adoptedAgentIds: [childId]
    })
    // The orphan now routes to the root queue.
    expect(queueForAgent(runtime, childId)).toBe(runtime.events)
    // Adopting twice is a no-op.
    adoptSubtree(runtime, leadId)
    expect(runtime.events.all().filter((event) => event.type === 'subtree_adopted')).toHaveLength(1)
  })
})

describe('integrate_branch — E1', () => {
  it('merges via the host, pushes integrate_ok, and warns when nobody reported done on the branch', async () => {
    const { runtime, tools } = setup()
    const started = await callTool(tools, 'start_agent', { role: 'worker', task: 't' })
    const agentId = String(started.json.agentId)

    const result = await callTool(tools, 'integrate_branch', {
      agentId,
      branch: 'vertragus/arsenale/other'
    })

    expect(result.isError).toBe(false)
    expect(runtime.host.integrations).toEqual([{ agentId, branch: 'vertragus/arsenale/other' }])
    expect(String(result.json.warning)).toMatch(/nobody verified/i)
    expect(runtime.events.all().at(-1)).toMatchObject({
      type: 'integrate_ok',
      agentId,
      branch: 'vertragus/arsenale/other'
    })
  })

  it('does not warn when the branch carries a clean success report', async () => {
    const { runtime, tools } = setup()
    const started = await callTool(tools, 'start_agent', { role: 'worker', task: 't' })
    const agentId = String(started.json.agentId)
    runtime.events.push({
      type: 'agent_done',
      agentId: 'agent-0',
      name: 'Caronte',
      roleId: 'worker',
      summary: 'done',
      status: 'success',
      branch: 'vertragus/arsenale/other',
      uncommitted: false
    })

    const result = await callTool(tools, 'integrate_branch', {
      agentId,
      branch: 'vertragus/arsenale/other'
    })
    expect(result.json.warning).toBeUndefined()
  })

  it('a conflict aborts, reports the files, and pushes integrate_conflict', async () => {
    const { runtime, tools } = setup()
    runtime.host.integrateConflict = { conflictFiles: ['src/a.ts'], message: 'CONFLICT' }
    const started = await callTool(tools, 'start_agent', { role: 'worker', task: 't' })
    const agentId = String(started.json.agentId)

    const result = await callTool(tools, 'integrate_branch', { agentId, branch: 'other' })

    expect(result.isError).toBe(true)
    expect(result.json).toMatchObject({ error: 'integrate_conflict', conflictFiles: ['src/a.ts'] })
    expect(runtime.events.all().at(-1)).toMatchObject({
      type: 'integrate_conflict',
      agentId,
      conflictFiles: ['src/a.ts']
    })
  })

  it('stays fenced to the caller’s subtree — the root cannot merge into a grandchild', async () => {
    const runtime = fakeRuntime()
    const rootTools = captureTools((server) => registerOrchestratorTools(server, runtime))
    await callTool(rootTools, 'start_orchestrator', { area: 'x', task: 't' })
    const leadId = [...runtime.leads.keys()][0]!
    const leadTools = captureTools((server) =>
      registerOrchestratorTools(server, runtime, { leadId })
    )
    const child = await callTool(leadTools, 'start_agent', { role: 'worker', task: 't' })
    const grandchildId = String(child.json.agentId)

    const result = await callTool(rootTools, 'integrate_branch', {
      agentId: grandchildId,
      branch: 'b'
    })
    expect(result.isError).toBe(true)
    expect(result.json.error).toBe('unknown_agent')
    // The lead itself may integrate within its subtree.
    expect(
      (await callTool(leadTools, 'integrate_branch', { agentId: grandchildId, branch: 'b' })).isError
    ).toBe(false)
  })
})

describe('budget — E4', () => {
  it('refuses new starts once the budget is spent and announces it exactly once', async () => {
    const { runtime, tools } = setup()
    runtime.host.budgetState = { usedSec: 601, limitSec: 600, exhausted: true }

    const refused = await callTool(tools, 'start_agent', { role: 'worker', task: 't' })
    expect(refused.isError).toBe(true)
    expect(refused.json).toMatchObject({ error: 'budget_exhausted', limitSec: 600 })

    const refusedLead = await callTool(tools, 'start_orchestrator', { area: 'x', task: 't' })
    expect(refusedLead.isError).toBe(true)

    const warnings = runtime.events.all().filter((event) => event.type === 'budget_warning')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatchObject({ exhausted: true, usedSec: 601, limitSec: 600 })

    // Everything that is not a new start keeps working — wrap-up needs tools.
    expect((await callTool(tools, 'list_agents', {})).isError).toBe(false)
  })

  it('announces the 80% threshold once without refusing anything', async () => {
    const { runtime, tools } = setup()
    runtime.host.budgetState = { usedSec: 500, limitSec: 600, exhausted: false }

    expect((await callTool(tools, 'start_agent', { role: 'worker', task: 't' })).isError).toBe(false)
    expect((await callTool(tools, 'start_agent', { role: 'worker', task: 't' })).isError).toBe(false)

    const warnings = runtime.events.all().filter((event) => event.type === 'budget_warning')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatchObject({ exhausted: false })
  })

  it('no budget configured → no gate, no events', async () => {
    const { runtime, tools } = setup()
    expect((await callTool(tools, 'start_agent', { role: 'worker', task: 't' })).isError).toBe(false)
    expect(runtime.events.all().some((event) => event.type === 'budget_warning')).toBe(false)
  })
})

describe('record_retro repoNotes — E2', () => {
  it('hands repo notes to the retro port and reports the applied count', async () => {
    const recorded: string[][] = []
    const runtime = fakeRuntime({
      retro: {
        recordLearnings: () => ({ applied: 0 }),
        recordSummary: () => undefined,
        recordRepoNotes: (notes) => {
          recorded.push([...notes])
          return { applied: notes.length }
        }
      }
    })
    const tools = captureTools((server) => registerOrchestratorTools(server, runtime))

    const result = await callTool(tools, 'record_retro', {
      summary: 'Went fine.',
      repoNotes: ['tests need pnpm run ci']
    })

    expect(result.isError).toBe(false)
    expect(result.json.appliedRepoNotes).toBe(1)
    expect(recorded).toEqual([['tests need pnpm run ci']])
  })
})

describe('request_succession', () => {
  it('returns succession_started and does not wait for the successor spawn', async () => {
    const { runtime, tools } = setup()
    const result = await callTool(tools, 'request_succession', {
      reason: 'context_full',
      nextActions: ['answer the open question']
    })
    expect(result.isError).toBe(false)
    expect(result.json).toMatchObject({
      state: 'succession_started',
      predecessorAgentId: 'orch-live',
      eventCursor: 0
    })
    expect(runtime.host.successionCalls).toHaveLength(1)
    expect(runtime.host.successionCalls[0]).toMatchObject({ reason: 'context_full' })
  })

  it('refuses a second succession and mutating tools while one is in flight', async () => {
    const host = new FakeAgentHost({ holdSuccession: true })
    const { tools } = setup({ host, retro: { recordLearnings: () => ({ applied: 0 }), recordSummary: () => undefined } })

    const first = await callTool(tools, 'request_succession', { reason: 'long_run' })
    expect(first.isError).toBe(false)

    const second = await callTool(tools, 'request_succession', { reason: 'other' })
    expect(second.isError).toBe(true)
    expect(second.json.error).toBe('already_in_progress')

    const start = await callTool(tools, 'start_agent', { role: 'worker', task: 't' })
    expect(start.json.error).toBe('succession_in_progress')
    const retro = await callTool(tools, 'record_retro', { summary: 'done' })
    expect(retro.json.error).toBe('succession_in_progress')
    const send = await callTool(tools, 'send_to_agent', { agentId: 'x', text: 'hi' })
    expect(send.json.error).toBe('succession_in_progress')

    host.completeSuccession()
  })

  it('still allows list_agents during succession', async () => {
    const host = new FakeAgentHost({ holdSuccession: true })
    const { tools } = setup({ host })
    await callTool(tools, 'request_succession', { reason: 'context_full' })
    const listed = await callTool(tools, 'list_agents')
    expect(listed.isError).toBe(false)
    host.completeSuccession()
  })
})
