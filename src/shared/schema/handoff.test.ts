import { describe, expect, it } from 'vitest'
import {
  PACKAGE_MAX_CHARS,
  buildHandoffPackage,
  capText,
  compactRecentEvents,
  orchestratorHandoffPackageSchema
} from './handoff'

describe('capText', () => {
  it('leaves short strings alone and ellipsizes long ones', () => {
    expect(capText('ok', 10)).toEqual({ value: 'ok', truncated: false })
    expect(capText('abcdefghij', 8)).toEqual({ value: 'abcdefg…', truncated: true })
  })
})

describe('compactRecentEvents', () => {
  it('prefers done/question/exited over progress and keeps the tail', () => {
    const events = [
      { seq: 1, type: 'agent_progress', agentId: 'a1', name: 'A' },
      { seq: 2, type: 'agent_done', agentId: 'a1', name: 'A', summary: 'fixed' },
      { seq: 3, type: 'agent_question', agentId: 'a2', name: 'B', questionId: 'q1', question: 'which?' }
    ]
    expect(compactRecentEvents(events)).toEqual([
      { seq: 2, type: 'agent_done', agentId: 'a1', name: 'A', summary: 'fixed' },
      {
        seq: 3,
        type: 'agent_question',
        agentId: 'a2',
        name: 'B',
        questionId: 'q1',
        question: 'which?'
      }
    ])
  })
})

describe('buildHandoffPackage', () => {
  const base = {
    workspaceId: 'ws',
    workspaceName: 'Paradiso',
    profileId: 'p1',
    createdAt: 1,
    reason: 'context_full' as const,
    predecessor: { agentId: 'o1', name: 'Virgilio', providerId: 'claude' },
    successorAgentId: 'o2',
    eventCursor: 9,
    agents: [{ agentId: 'a1', name: 'Caronte', role: 'worker', status: 'working' }],
    openQuestions: [{ questionId: 'q1', agentId: 'a1', question: 'which file?' }],
    recentEvents: [{ seq: 9, type: 'agent_done', agentId: 'a1', summary: 'ok' }]
  }

  it('parses a minimal valid package and never drops open questions', () => {
    const pkg = buildHandoffPackage(base)
    expect(orchestratorHandoffPackageSchema.parse(pkg).openQuestions).toEqual(base.openQuestions)
    expect(pkg.eventCursor).toBe(9)
    expect(pkg.kind).toBe('orchestrator_succession')
  })

  it('caps orch prose before dropping agent ids', () => {
    const pkg = buildHandoffPackage({
      ...base,
      decisions: Array.from({ length: 20 }, (_, i) => `d${i}:${'x'.repeat(400)}`)
    })
    expect(pkg.decisions.length).toBeLessThanOrEqual(15)
    expect(pkg.agents).toHaveLength(1)
    expect(pkg.limits.truncated).toContain('decisions')
  })

  it('shrinks recentEvents to stay under the package size cap', () => {
    const recentEvents = Array.from({ length: 40 }, (_, i) => ({
      seq: i + 1,
      type: 'agent_done',
      agentId: 'a1',
      summary: 's'.repeat(800)
    }))
    const pkg = buildHandoffPackage({ ...base, recentEvents })
    expect(JSON.stringify(pkg).length).toBeLessThanOrEqual(PACKAGE_MAX_CHARS)
    expect(pkg.agents[0]?.agentId).toBe('a1')
    expect(pkg.openQuestions).toHaveLength(1)
  })

  it('S4: carries the task board rows, capping subjects but never dropping rows', () => {
    const tasks = [
      {
        taskId: 'task-1',
        revision: 3,
        subject: 's'.repeat(300),
        status: 'in_progress',
        ownerAgentId: 'a1',
        blockedBy: []
      },
      { taskId: 'task-2', revision: 1, subject: 'small', status: 'pending', blockedBy: ['task-1'] }
    ]
    // The same size pressure that shrinks recentEvents must not touch tasks.
    const recentEvents = Array.from({ length: 40 }, (_, i) => ({
      seq: i + 1,
      type: 'agent_done',
      agentId: 'a1',
      summary: 's'.repeat(800)
    }))
    const pkg = buildHandoffPackage({ ...base, tasks, recentEvents })
    expect(JSON.stringify(pkg).length).toBeLessThanOrEqual(PACKAGE_MAX_CHARS)
    expect(pkg.tasks).toHaveLength(2)
    expect(pkg.tasks[0]).toMatchObject({ taskId: 'task-1', revision: 3, ownerAgentId: 'a1' })
    expect(pkg.tasks[0]!.subject).toHaveLength(200)
    expect(pkg.limits.truncated).toContain('tasks.subject')
    expect(pkg.tasks[1]).toEqual(tasks[1])
    // A run without a board still validates — tasks default to empty.
    expect(buildHandoffPackage(base).tasks).toEqual([])
  })

  it('records the real size, and admits it when the protected fields blow the cap', () => {
    const small = buildHandoffPackage(base)
    // Measured before the admission fields were appended — off by their own
    // length and nothing else (see the schema's note on `chars`).
    expect(JSON.stringify(small).length - small.limits.chars!).toBeLessThan(30)
    expect(small.limits.overCap).toBeUndefined()

    // A board near TASKS_MAX with long subjects: tasks and open questions are
    // never dropped, so the shrink loops run out of material while the package
    // is still over the cap. That must be recorded, not quietly over-claimed.
    const tasks = Array.from({ length: 200 }, (_, i) => ({
      taskId: `task-${i + 1}`,
      revision: 1,
      subject: 's'.repeat(200),
      status: 'pending',
      blockedBy: []
    }))
    const pkg = buildHandoffPackage({ ...base, tasks })
    expect(pkg.tasks).toHaveLength(200)
    expect(pkg.recentEvents).toHaveLength(0)
    expect(pkg.limits.overCap).toBe(true)
    expect(pkg.limits.chars).toBeGreaterThan(PACKAGE_MAX_CHARS)
    // Still a valid package: the successor gets everything, `limits` no longer
    // claims a size the package does not have.
    expect(orchestratorHandoffPackageSchema.parse(pkg).openQuestions).toHaveLength(1)
  })
})
