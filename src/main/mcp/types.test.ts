import { describe, expect, it } from 'vitest'
import { EventQueue } from './eventQueue'
import {
  MAX_HELPERS_PER_WORKER,
  WORKER_NEST_AREA,
  adoptSubtree,
  attachSubtreeAdoptionTap,
  canSpawnHelpers,
  ensureNest,
  queueForAgent,
  slimAgentsSummary,
  summarizeAgents
} from './types'
import { FakeAgentHost, fakeRuntime } from './testing'

describe('canSpawnHelpers', () => {
  it('allows a root-level worker and a lead’s worker, and refuses a helper', () => {
    const runtime = fakeRuntime()
    expect(canSpawnHelpers(runtime, 'worker-root')).toBe(true)

    runtime.leads.set('lead-1', {
      agentId: 'lead-1',
      area: 'payments',
      events: new EventQueue(),
      maxSubagents: 2
    })
    runtime.parentOf.set('worker-of-lead', 'lead-1')
    expect(canSpawnHelpers(runtime, 'worker-of-lead')).toBe(true)

    ensureNest(runtime, 'worker-of-lead')
    runtime.parentOf.set('helper-1', 'worker-of-lead')
    expect(canSpawnHelpers(runtime, 'helper-1')).toBe(false)
  })
})

describe('ensureNest', () => {
  it('is idempotent and does not double-fire onLeadCreated', () => {
    const runtime = fakeRuntime()
    const created: string[] = []
    runtime.onLeadCreated = (nest) => created.push(nest.agentId)

    const first = ensureNest(runtime, 'worker-1')
    const second = ensureNest(runtime, 'worker-1')
    expect(second).toBe(first)
    expect(created).toEqual(['worker-1'])
    expect(first.area).toBe(WORKER_NEST_AREA)
    expect(first.maxSubagents).toBe(MAX_HELPERS_PER_WORKER)
  })

  it('mints a fresh queue when the previous nest was closed', () => {
    const runtime = fakeRuntime()
    const first = ensureNest(runtime, 'worker-1')
    first.events.close()
    const second = ensureNest(runtime, 'worker-1')
    expect(second).not.toBe(first)
    expect(second.events.isClosed).toBe(false)
  })
})

describe('queueForAgent / adoptSubtree — worker nests', () => {
  it('routes a helper’s events to the worker nest, not the root', () => {
    const runtime = fakeRuntime()
    const nest = ensureNest(runtime, 'worker-1')
    runtime.parentOf.set('helper-1', 'worker-1')
    expect(queueForAgent(runtime, 'helper-1')).toBe(nest.events)
    expect(queueForAgent(runtime, 'worker-1')).toBe(runtime.events)
  })

  it('reparents helpers one level up (to the lead) and tells that lead once', () => {
    const runtime = fakeRuntime()
    runtime.leads.set('lead-1', {
      agentId: 'lead-1',
      area: 'payments',
      events: new EventQueue(),
      maxSubagents: 3
    })
    runtime.parentOf.set('worker-1', 'lead-1')
    const nest = ensureNest(runtime, 'worker-1')
    runtime.parentOf.set('helper-1', 'worker-1')
    const parked = runtime.leads.get('lead-1')!.events.wait(
      runtime.leads.get('lead-1')!.events.cursor,
      5_000
    )

    adoptSubtree(runtime, 'worker-1')

    expect(runtime.nests.has('worker-1')).toBe(false)
    expect(runtime.parentOf.get('helper-1')).toBe('lead-1')
    expect(nest.events.isClosed).toBe(true)
    expect(queueForAgent(runtime, 'helper-1')).toBe(runtime.leads.get('lead-1')!.events)
    return expect(parked).resolves.toEqual([
      expect.objectContaining({
        type: 'subtree_adopted',
        leadAgentId: 'worker-1',
        area: WORKER_NEST_AREA,
        adoptedAgentIds: ['helper-1']
      })
    ])
  })

  it('reparents to the root when the worker had no parent', () => {
    const runtime = fakeRuntime()
    ensureNest(runtime, 'worker-1')
    runtime.parentOf.set('helper-1', 'worker-1')
    adoptSubtree(runtime, 'worker-1')
    expect(runtime.parentOf.has('helper-1')).toBe(false)
    expect(queueForAgent(runtime, 'helper-1')).toBe(runtime.events)
    expect(runtime.events.all().at(-1)).toMatchObject({
      type: 'subtree_adopted',
      leadAgentId: 'worker-1',
      adoptedAgentIds: ['helper-1']
    })
  })

  it('closes an empty nest without a subtree_adopted event', () => {
    const runtime = fakeRuntime()
    ensureNest(runtime, 'worker-1')
    adoptSubtree(runtime, 'worker-1')
    expect(runtime.nests.has('worker-1')).toBe(false)
    expect(runtime.events.all()).toEqual([])
  })
})

describe('attachSubtreeAdoptionTap', () => {
  it('adopts when a nested worker’s death lands on the lead queue', () => {
    const runtime = fakeRuntime()
    const leadEvents = new EventQueue()
    runtime.leads.set('lead-1', {
      agentId: 'lead-1',
      area: 'docs',
      events: leadEvents,
      maxSubagents: 2
    })
    attachSubtreeAdoptionTap(runtime, runtime.leads.get('lead-1')!)
    runtime.parentOf.set('worker-1', 'lead-1')
    ensureNest(runtime, 'worker-1')
    runtime.parentOf.set('helper-1', 'worker-1')

    leadEvents.push({
      type: 'agent_exited',
      agentId: 'worker-1',
      name: 'Caronte',
      roleId: 'worker',
      confirmed: false
    })

    expect(runtime.nests.has('worker-1')).toBe(false)
    expect(runtime.parentOf.get('helper-1')).toBe('lead-1')
  })
})

describe('summarizeAgents childCount', () => {
  it('counts helpers under a worker as well as children under a lead', () => {
    const runtime = fakeRuntime()
    const host = runtime.host as FakeAgentHost
    host.beginAgent({ role: 'worker', task: 't' })
    const workerId = [...host.agents.keys()][0]!
    ensureNest(runtime, workerId)
    runtime.parentOf.set('helper-x', workerId)
    host.agents.set('helper-x', {
      agentId: 'helper-x',
      name: 'Helper',
      role: 'worker',
      status: 'running',
      lastOutputAgeSec: 0,
      reporting: 'mcp'
    })

    const rows = summarizeAgents(runtime)
    const worker = rows.find((row) => row.agentId === workerId)
    expect(worker?.childCount).toBe(1)
  })
})

describe('summarizeAgents pendingQuestionChoices', () => {
  it('copies open choices onto the full and slim rows', () => {
    const runtime = fakeRuntime()
    const host = runtime.host as FakeAgentHost
    host.beginAgent({ role: 'worker', task: 't' })
    const workerId = [...host.agents.keys()][0]!
    runtime.questions.create(workerId, 'which db?', { choices: ['Postgres', 'SQLite'] })

    const full = summarizeAgents(runtime).find((row) => row.agentId === workerId)
    expect(full).toMatchObject({
      pendingQuestion: 'which db?',
      pendingQuestionChoices: ['Postgres', 'SQLite']
    })
    const slim = slimAgentsSummary(runtime).find((row) => row.agentId === workerId)
    expect(slim).toMatchObject({
      pendingQuestion: 'which db?',
      pendingQuestionChoices: ['Postgres', 'SQLite']
    })
    expect(slim).not.toHaveProperty('worktreePath')
  })
})

describe('summarizeAgents tokenUsage', () => {
  it('keeps tokenUsage on the full row and drops it from the slim row', () => {
    const runtime = fakeRuntime()
    const host = runtime.host as FakeAgentHost
    host.beginAgent({ role: 'worker', task: 't' })
    const workerId = [...host.agents.keys()][0]!
    const usage = { kind: 'consumption' as const, input: 10, output: 2, total: 12 }
    host.agents.set(workerId, { ...host.agents.get(workerId)!, tokenUsage: usage })

    const full = summarizeAgents(runtime).find((row) => row.agentId === workerId)
    expect(full?.tokenUsage).toEqual(usage)
    const slim = slimAgentsSummary(runtime).find((row) => row.agentId === workerId)
    expect(slim).not.toHaveProperty('tokenUsage')
  })
})
