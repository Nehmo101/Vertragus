import { describe, expect, it, vi } from 'vitest'
import { CONTRACT_MARKER } from '@shared/prompts/contract'
import { ORCHESTRATOR_TOOL_NAMES, registerOrchestratorTools } from './toolsOrchestrator'
import { callTool, captureTools, FakeAgentHost, fakeRuntime } from './testing'

function setup(options: Parameters<typeof fakeRuntime>[0] = {}) {
  const runtime = fakeRuntime(options)
  const tools = captureTools((server) => registerOrchestratorTools(server, runtime))
  return { runtime, tools }
}

describe('orchestrator tool surface', () => {
  it('registers exactly the eight documented tools', () => {
    const { tools } = setup()
    expect([...tools.keys()].sort()).toEqual([...ORCHESTRATOR_TOOL_NAMES].sort())
  })

  it('describes every tool for the model', () => {
    const { tools } = setup()
    for (const tool of tools.values()) expect(tool.description?.length ?? 0).toBeGreaterThan(40)
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
    const result = await callTool(tools, 'await_events', { cursor: 7, timeoutSec: 1 })
    expect(result.json.events).toEqual([])
    expect(result.json.cursor).toBe(7)
    expect(String(result.json.note)).toMatch(/call await_events again/i)
  })

  it('clamps the timeout to 55 s by rejecting anything larger', async () => {
    const { tools } = setup()
    await expect(callTool(tools, 'await_events', { timeoutSec: 900 })).rejects.toThrow()
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
