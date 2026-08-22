import { describe, expect, it } from 'vitest'
import type { RemoteAgentSummary, RemoteTaskSummary } from '@shared/remote/protocol'
import { taskBoardSize, taskRows, type TaskBoardCopy } from './taskBoard'

const copy: TaskBoardCopy = {
  taskPending: 'offen',
  taskInProgress: 'läuft',
  taskCompleted: 'fertig',
  taskReady: 'bereit',
  taskBlocked: (count) => (count === 1 ? 'wartet auf 1 Aufgabe' : `wartet auf ${count} Aufgaben`),
  taskNotReady: 'noch nicht bereit',
  taskOwner: (name) => `bei ${name}`
}

function task(overrides: Partial<RemoteTaskSummary> = {}): RemoteTaskSummary {
  return {
    taskId: 't1',
    subject: 'Build the parser',
    status: 'pending',
    blockedBy: [],
    ready: true,
    ...overrides
  }
}

const agents: RemoteAgentSummary[] = [
  { agentId: 'a1', name: 'Caronte', roleId: 'worker', roleColor: '#2f7d6d', state: 'working' }
]

describe('taskRows', () => {
  it('orders in-flight, ready, blocked, unplanned, done', () => {
    const rows = taskRows(
      [
        task({ taskId: 'done', status: 'completed', ready: false }),
        task({ taskId: 'blocked', ready: false, blockedBy: ['done', 'running'] }),
        task({ taskId: 'ready' }),
        task({ taskId: 'idle', ready: false }),
        task({ taskId: 'running', status: 'in_progress', ready: false })
      ],
      agents,
      copy
    )
    expect(rows.map((row) => row.taskId)).toEqual(['running', 'ready', 'blocked', 'idle', 'done'])
    expect(rows.map((row) => row.tone)).toEqual([
      'in-progress',
      'ready',
      'blocked',
      'pending',
      'done'
    ])
  })

  it('keeps the plan order inside one tone', () => {
    const rows = taskRows(
      [task({ taskId: 'first' }), task({ taskId: 'second' }), task({ taskId: 'third' })],
      agents,
      copy
    )
    expect(rows.map((row) => row.taskId)).toEqual(['first', 'second', 'third'])
  })

  it('counts only blockers that are still open', () => {
    const [row] = taskRows(
      [
        task({ taskId: 'a', status: 'completed', ready: false }),
        task({ taskId: 'b', status: 'pending', ready: false }),
        task({ taskId: 'blocked', ready: false, blockedBy: ['a', 'b'] })
      ],
      agents,
      copy
    ).filter((entry) => entry.taskId === 'blocked')
    expect(row?.readinessLabel).toBe('wartet auf 1 Aufgabe')
  })

  it('counts a blocker the board no longer carries as still open', () => {
    // The client cannot prove a task it has never seen finished, and telling a
    // user a row is free when it is not is the worse of the two lies.
    const [row] = taskRows([task({ ready: false, blockedBy: ['gone', 'also-gone'] })], agents, copy)
    expect(row?.readinessLabel).toBe('wartet auf 2 Aufgaben')
  })

  it('does not invent blockers when the board disagrees with itself', () => {
    // Every declared blocker reads as done, yet the host says not ready. The
    // old fallback answered that by counting the FINISHED blockers — "waiting
    // on 1 task" about a task that is complete. There is nothing to count, and
    // the row says so in words rather than leaving the stripe to carry it.
    const [stale] = taskRows(
      [
        task({ taskId: 'a', status: 'completed', ready: false }),
        task({ taskId: 'stale', ready: false, blockedBy: ['a'] })
      ],
      agents,
      copy
    ).filter((entry) => entry.taskId === 'stale')
    expect(stale?.tone).toBe('blocked')
    expect(stale?.readinessLabel).toBe('noch nicht bereit')
    expect(stale?.readinessLabel).not.toContain('1')
  })

  it('counts only what is still open when the board can see all of it', () => {
    const [row] = taskRows(
      [
        task({ taskId: 'done1', status: 'completed', ready: false }),
        task({ taskId: 'done2', status: 'completed', ready: false }),
        task({ taskId: 'open', status: 'in_progress', ready: false }),
        task({ taskId: 'blocked', ready: false, blockedBy: ['done1', 'done2', 'open'] })
      ],
      agents,
      copy
    ).filter((entry) => entry.taskId === 'blocked')
    expect(row?.readinessLabel).toBe('wartet auf 1 Aufgabe')
  })

  it('resolves the owner to a Commedia name and hides an id it cannot resolve', () => {
    const [owned, orphan, none] = taskRows(
      [
        task({ taskId: 'owned', ownerAgentId: 'a1' }),
        task({ taskId: 'orphan', ownerAgentId: 'a9' }),
        task({ taskId: 'none' })
      ],
      agents,
      copy
    )
    expect(owned?.ownerLabel).toBe('bei Caronte')
    expect(orphan?.ownerLabel).toBeUndefined()
    expect(none?.ownerLabel).toBeUndefined()
  })

  it('says nothing extra about work that is running or done', () => {
    const rows = taskRows(
      [
        task({ taskId: 'running', status: 'in_progress', ready: false }),
        task({ taskId: 'done', status: 'completed', ready: false })
      ],
      agents,
      copy
    )
    expect(rows.map((row) => row.statusLabel)).toEqual(['läuft', 'fertig'])
    expect(rows.every((row) => row.readinessLabel === undefined)).toBe(true)
  })

  it('draws nothing for a run without a plan', () => {
    expect(taskRows(undefined, agents, copy)).toEqual([])
    expect(taskRows([], agents, copy)).toEqual([])
    expect(taskBoardSize(undefined)).toBe(0)
  })
})

describe('board size', () => {
  it('counts every row the toggle would reveal', () => {
    expect(
      taskBoardSize([
        task({ taskId: 'a', status: 'completed', ready: false }),
        task({ taskId: 'b', status: 'in_progress', ready: false })
      ])
    ).toBe(2)
    expect(taskBoardSize([])).toBe(0)
  })
})
