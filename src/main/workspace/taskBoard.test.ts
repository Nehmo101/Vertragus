import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { taskBoardSchema, TASKS_MAX } from '@shared/schema/tasks'
import { createTaskBoard, type TaskBoardDeps } from './taskBoard'

/** In-memory fs recording the op ORDER — the atomic tmp+rename claim needs it. */
function fakeFs(): {
  ops: string[]
  files: Map<string, string>
  warn: ReturnType<typeof vi.fn>
  deps: TaskBoardDeps
} {
  const ops: string[] = []
  const files = new Map<string, string>()
  const warn = vi.fn()
  const deps: TaskBoardDeps = {
    mkdir: vi.fn(async () => undefined),
    writeFile: (async (path: unknown, data: unknown) => {
      ops.push(`write ${String(path)}`)
      files.set(String(path), String(data))
    }) as never,
    rename: (async (from: unknown, to: unknown) => {
      ops.push(`rename ${String(from)} -> ${String(to)}`)
      files.set(String(to), files.get(String(from))!)
      files.delete(String(from))
    }) as never,
    warn,
    now: () => 1_000
  }
  return { ops, files, warn, deps }
}

function board(deps?: TaskBoardDeps) {
  return createTaskBoard('/repo', 'ws-1', deps ?? fakeFs().deps)
}

describe('createTaskBoard — S4 basics', () => {
  it('creates task-N ids with revision 1 and lists them', () => {
    const store = board()
    const first = store.create({ subject: 'Build the parser' })
    const second = store.create({ subject: 'Test the parser', description: 'vitest' })
    expect(first).toMatchObject({ ok: true, task: { taskId: 'task-1', revision: 1, status: 'pending' } })
    expect(second).toMatchObject({ ok: true, task: { taskId: 'task-2', description: 'vitest' } })
    expect(store.list().map((task) => task.taskId)).toEqual(['task-1', 'task-2'])
    expect(store.get('task-2')?.subject).toBe('Test the parser')
  })

  it('a task born with an owner is an assignment — in_progress, like claim', () => {
    const store = board()
    const created = store.create({ subject: 'S', ownerAgentId: 'agent-7' })
    expect(created).toMatchObject({ ok: true, task: { status: 'in_progress', ownerAgentId: 'agent-7' } })
  })

  it('refuses the 201st task with task_limit', () => {
    const store = board()
    for (let index = 0; index < TASKS_MAX; index += 1) {
      expect(store.create({ subject: `t${index}` }).ok).toBe(true)
    }
    expect(store.create({ subject: 'one too many' })).toMatchObject({
      ok: false,
      error: 'task_limit',
      max: TASKS_MAX
    })
  })
})

describe('CAS revisions', () => {
  it('every accepted mutation bumps the revision by one', () => {
    const store = board()
    store.create({ subject: 'S' })
    const claimed = store.update('task-1', 1, 'claim', { ownerAgentId: 'agent-1' })
    expect(claimed).toMatchObject({ ok: true, task: { revision: 2, status: 'in_progress' } })
    const released = store.update('task-1', 2, 'release')
    expect(released).toMatchObject({ ok: true, task: { revision: 3, status: 'pending' } })
    expect(store.get('task-1')?.ownerAgentId).toBeUndefined()
  })

  it('stale_revision carries the CURRENT task so the caller reconciles without a read', () => {
    const store = board()
    store.create({ subject: 'S' })
    store.update('task-1', 1, 'edit', { subject: 'Renamed' })
    const stale = store.update('task-1', 1, 'complete')
    expect(stale.ok).toBe(false)
    if (stale.ok || stale.error !== 'stale_revision') throw new Error('expected stale_revision')
    expect(stale.task).toMatchObject({ taskId: 'task-1', revision: 2, subject: 'Renamed' })
    // The carried task is the live one — retrying with ITS revision succeeds.
    expect(store.update('task-1', stale.task.revision, 'complete').ok).toBe(true)
  })

  it('a rejected mutation does not move the revision', () => {
    const store = board()
    store.create({ subject: 'S' })
    expect(store.update('task-1', 1, 'release')).toMatchObject({ ok: false, error: 'invalid_transition' })
    expect(store.get('task-1')?.revision).toBe(1)
  })
})

describe('transitions', () => {
  it('claim needs pending; reopen needs completed; release needs in_progress', () => {
    const store = board()
    store.create({ subject: 'S' })
    store.update('task-1', 1, 'claim', { ownerAgentId: 'a' })
    expect(store.update('task-1', 2, 'claim', { ownerAgentId: 'b' })).toMatchObject({
      ok: false,
      error: 'invalid_transition',
      status: 'in_progress',
      action: 'claim'
    })
    expect(store.update('task-1', 2, 'reopen')).toMatchObject({ ok: false, error: 'invalid_transition' })
    expect(store.update('task-1', 2, 'complete').ok).toBe(true)
    expect(store.update('task-1', 3, 'release')).toMatchObject({ ok: false, error: 'invalid_transition' })
    // reopen frees the owner — the work restarts unowned.
    const reopened = store.update('task-1', 3, 'reopen')
    expect(reopened).toMatchObject({ ok: true, task: { status: 'pending' } })
    expect(store.get('task-1')?.ownerAgentId).toBeUndefined()
  })

  it('claim and reassign without ownerAgentId are missing_field, not silent no-ops', () => {
    const store = board()
    store.create({ subject: 'S' })
    expect(store.update('task-1', 1, 'claim')).toMatchObject({ ok: false, error: 'missing_field' })
    expect(store.update('task-1', 1, 'reassign')).toMatchObject({ ok: false, error: 'missing_field' })
  })

  it('unknown ids are unknown_task', () => {
    expect(board().update('task-9', 1, 'complete')).toMatchObject({ ok: false, error: 'unknown_task' })
  })
})

describe('dependencies and cycles', () => {
  it('rejects an edge that closes a cycle — direct and transitive', () => {
    const store = board()
    store.create({ subject: 'A' })
    store.create({ subject: 'B', blockedBy: ['task-1'] })
    store.create({ subject: 'C', blockedBy: ['task-2'] })
    expect(store.update('task-1', 1, 'set_dependencies', { blockedBy: ['task-3'] })).toMatchObject({
      ok: false,
      error: 'dependency_cycle'
    })
    expect(store.update('task-1', 1, 'set_dependencies', { blockedBy: ['task-2'] })).toMatchObject({
      ok: false,
      error: 'dependency_cycle'
    })
    // A cycle-free edge still lands.
    expect(store.update('task-3', 1, 'set_dependencies', { blockedBy: ['task-1', 'task-2'] }).ok).toBe(true)
  })

  it('rejects unknown and deleted dependencies at create and set_dependencies', () => {
    const store = board()
    store.create({ subject: 'A' })
    store.update('task-1', 1, 'delete')
    expect(store.create({ subject: 'B', blockedBy: ['task-404'] })).toMatchObject({
      ok: false,
      error: 'unknown_task',
      taskId: 'task-404'
    })
    expect(store.create({ subject: 'B', blockedBy: ['task-1'] })).toMatchObject({
      ok: false,
      error: 'dependency_deleted',
      dependencyId: 'task-1'
    })
    store.create({ subject: 'B' })
    expect(store.update('task-2', 1, 'set_dependencies', { blockedBy: ['task-1'] })).toMatchObject({
      ok: false,
      error: 'dependency_deleted'
    })
  })
})

describe('tombstones and ready derivation', () => {
  it('delete is a tombstone: final, and every further action answers task_deleted', () => {
    const store = board()
    store.create({ subject: 'S' })
    const deleted = store.update('task-1', 1, 'delete')
    expect(deleted).toMatchObject({ ok: true, task: { status: 'deleted', revision: 2 } })
    expect(store.update('task-1', 2, 'reopen')).toMatchObject({ ok: false, error: 'task_deleted' })
    expect(store.update('task-1', 2, 'delete')).toMatchObject({ ok: false, error: 'task_deleted' })
    // Still listed — the successor's task_list may show tombstones by filter.
    expect(store.list({ status: 'deleted' })).toHaveLength(1)
  })

  it('ready = pending with all blockedBy completed; deleted references are ignored, not cascaded', () => {
    const store = board()
    store.create({ subject: 'A' })
    store.create({ subject: 'B' })
    store.create({ subject: 'C', blockedBy: ['task-1', 'task-2'] })
    expect(store.isReady('task-3')).toBe(false)

    store.update('task-1', 1, 'complete')
    expect(store.isReady('task-3')).toBe(false)

    // The tombstone stops blocking — C keeps its stale reference on purpose.
    store.update('task-2', 1, 'delete')
    expect(store.isReady('task-3')).toBe(true)
    expect(store.get('task-3')?.blockedBy).toEqual(['task-1', 'task-2'])

    // Non-pending tasks are never ready, whatever their dependencies say.
    store.update('task-3', 1, 'claim', { ownerAgentId: 'a' })
    expect(store.isReady('task-3')).toBe(false)
  })
})

describe('noteReport', () => {
  it('sets lastReport on every task the agent owns — and NEVER moves the status', () => {
    const store = board()
    store.create({ subject: 'Mine', ownerAgentId: 'agent-1' })
    store.create({ subject: 'Other', ownerAgentId: 'agent-2' })
    store.noteReport('agent-1', { status: 'success', summary: 'done and tested', headSha: 'abc' })
    const mine = store.get('task-1')!
    expect(mine.lastReport).toEqual({ status: 'success', summary: 'done and tested', headSha: 'abc' })
    expect(mine.status).toBe('in_progress') // verification stays the orchestrator's call
    expect(mine.revision).toBe(2) // a report is a mutation — the CAS token moves
    expect(store.get('task-2')?.lastReport).toBeUndefined()
  })

  it('caps the summary at 500 characters and ignores tombstones', () => {
    const store = board()
    store.create({ subject: 'Mine', ownerAgentId: 'agent-1' })
    store.update('task-1', 1, 'delete')
    store.noteReport('agent-1', { status: 'failed', summary: 'x'.repeat(600) })
    expect(store.get('task-1')?.lastReport).toBeUndefined()

    store.create({ subject: 'Live', ownerAgentId: 'agent-1' })
    store.noteReport('agent-1', { status: 'failed', summary: 'x'.repeat(600) })
    expect(store.get('task-2')?.lastReport?.summary).toHaveLength(500)
  })
})

describe('persistence — atomic whole-board snapshots', () => {
  it('writes tmp first, renames second, and the landed file is the schema-valid snapshot', async () => {
    const fs = fakeFs()
    const store = createTaskBoard('/repo', 'ws-1', fs.deps)
    const path = join('/repo', '.vertragus', 'runs', 'ws-1', 'tasks.json')
    expect(store.path).toBe(path)

    store.create({ subject: 'S' })
    store.update('task-1', 1, 'claim', { ownerAgentId: 'agent-1' })
    await store.flush()

    // Strict order per snapshot: tmp write, THEN rename — never in-place.
    expect(fs.ops).toEqual([
      `write ${path}.tmp`,
      `rename ${path}.tmp -> ${path}`,
      `write ${path}.tmp`,
      `rename ${path}.tmp -> ${path}`
    ])
    const landed = taskBoardSchema.parse(JSON.parse(fs.files.get(path)!))
    expect(landed).toEqual(store.snapshot())
    expect(landed.tasks[0]).toMatchObject({ taskId: 'task-1', revision: 2, status: 'in_progress' })
  })

  it('roundtrips through seed(): a parsed tasks.json restores the identical board', async () => {
    const fs = fakeFs()
    const store = createTaskBoard('/repo', 'ws-1', fs.deps)
    store.create({ subject: 'A' })
    store.create({ subject: 'B', blockedBy: ['task-1'] })
    store.update('task-1', 1, 'complete')
    await store.flush()

    const revived = board()
    revived.seed(taskBoardSchema.parse(JSON.parse(fs.files.get(store.path)!)))
    expect(revived.snapshot()).toEqual(store.snapshot())
    expect(revived.isReady('task-2')).toBe(true)
    // nextTaskNumber survives — new ids never collide with old ones.
    expect(revived.create({ subject: 'C' })).toMatchObject({ ok: true, task: { taskId: 'task-3' } })
  })

  it('fails soft on disk errors: warns once, keeps mutating in memory', async () => {
    const warn = vi.fn()
    const store = createTaskBoard('/repo', 'ws-1', {
      mkdir: vi.fn(async () => undefined),
      writeFile: (async () => {
        throw new Error('ENOSPC')
      }) as never,
      rename: vi.fn(async () => undefined) as never,
      warn,
      now: () => 1_000
    })
    store.create({ subject: 'A' })
    store.create({ subject: 'B' })
    await store.flush()
    expect(store.update('task-1', 1, 'complete').ok).toBe(true)
    await store.flush()

    expect(warn).toHaveBeenCalledTimes(1)
    expect(store.get('task-1')?.status).toBe('completed')
    expect(store.list()).toHaveLength(2)
  })
})
