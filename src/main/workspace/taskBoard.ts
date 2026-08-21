/**
 * S4: the host-side task board — the run's plan as durable host state, not
 * model context. The dsh pattern: CAS revisions, an acyclic `blockedBy` DAG,
 * ownership, tombstones.
 *
 * The AUTHORITATIVE state lives in memory; every accepted mutation is
 * validated synchronously, then the WHOLE board is persisted asynchronously as
 * one atomic snapshot (tmp + rename) to `.vertragus/runs/<workspaceId>/tasks.json`
 * on one serialized promise chain — same discipline as the journal, and the
 * same fail-soft: the first disk failure warns once, then persistence goes
 * quiet while the in-memory board keeps working. Snapshot instead of a change
 * log on purpose: ≤200 tasks, trivial recovery, no replay code. The journal
 * stays the event truth; the board is the plan truth.
 *
 * Errors are plain typed results, not throws — the tool layer forwards the
 * codes to the model. `stale_revision` carries the CURRENT task so the caller
 * reconciles without an extra read (dsh pattern).
 */
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentDoneStatus } from '@shared/schema/events'
import {
  taskSchema,
  TASKS_MAX,
  type Task,
  type TaskBoardState,
  type TaskStatus
} from '@shared/schema/tasks'
import { runsDir } from './journal'

export const TASK_ACTIONS = [
  'claim',
  'release',
  'edit',
  'set_dependencies',
  'complete',
  'reopen',
  'delete',
  'reassign'
] as const
export type TaskAction = (typeof TASK_ACTIONS)[number]

export interface TaskCreateFields {
  subject: string
  description?: string
  blockedBy?: string[]
  ownerAgentId?: string
}

export interface TaskUpdateFields {
  subject?: string
  description?: string
  blockedBy?: string[]
  ownerAgentId?: string
}

/** The lastReport slice of an agent_done — host facts, never a status change. */
export interface TaskReport {
  status: AgentDoneStatus
  summary: string
  headSha?: string
}

export type TaskBoardFailure =
  /** The presented revision is not the current one — `task` IS the current one. */
  | { ok: false; error: 'stale_revision'; task: Task }
  | { ok: false; error: 'unknown_task'; taskId: string }
  | { ok: false; error: 'task_deleted'; taskId: string }
  | { ok: false; error: 'dependency_cycle'; taskId: string; blockedBy: string[] }
  | { ok: false; error: 'dependency_deleted'; taskId: string; dependencyId: string }
  | { ok: false; error: 'task_limit'; max: number }
  | { ok: false; error: 'invalid_transition'; taskId: string; status: TaskStatus; action: TaskAction }
  | { ok: false; error: 'missing_field'; field: 'ownerAgentId' | 'blockedBy'; action: TaskAction }

export type TaskBoardResult = { ok: true; task: Task } | TaskBoardFailure

export interface TaskBoard {
  create(fields: TaskCreateFields): TaskBoardResult
  update(
    taskId: string,
    expectedRevision: number,
    action: TaskAction,
    fields?: TaskUpdateFields
  ): TaskBoardResult
  get(taskId: string): Task | undefined
  list(filter?: { status?: TaskStatus }): Task[]
  /** `ready` = pending AND every blockedBy completed (deleted refs ignored). */
  isReady(taskId: string): boolean
  /**
   * Record the owner's agent_done on every task it owns — display only,
   * NEVER a status change: completing stays an explicit orchestrator decision
   * after verification (host doctrine).
   */
  noteReport(agentId: string, done: TaskReport): void
  /** Deep copy of the whole board — for handoff packages and tests. */
  snapshot(): TaskBoardState
  /** Replace the board wholesale — used by resume to carry an old run's plan over. */
  seed(board: TaskBoardState): void
  /** Absolute path of tasks.json (for logs and tests). */
  path: string
  /** Settle the persistence chain (tests) — resolves even after a disk failure. */
  flush(): Promise<void>
}

export interface TaskBoardDeps {
  mkdir?: typeof mkdir
  writeFile?: typeof writeFile
  rename?: typeof rename
  warn?: (message: string, error: unknown) => void
  now?: () => number
}

const MAX_REPORT_SUMMARY = 500

/**
 * `ready` for one task against a lookup: pending, and every dependency
 * completed. References to deleted (or vanished) tasks are IGNORED instead of
 * cascaded — a tombstone must not block work forever.
 */
export function taskReady(task: Task, byId: (taskId: string) => Task | undefined): boolean {
  if (task.status !== 'pending') return false
  return task.blockedBy.every((dependencyId) => {
    const dependency = byId(dependencyId)
    if (!dependency || dependency.status === 'deleted') return true
    return dependency.status === 'completed'
  })
}

export function createTaskBoard(
  repoPath: string,
  workspaceId: string,
  deps: TaskBoardDeps = {}
): TaskBoard {
  const makeDir = deps.mkdir ?? mkdir
  const write = deps.writeFile ?? writeFile
  const move = deps.rename ?? rename
  const warn = deps.warn ?? ((message, error) => console.warn(message, error))
  const now = deps.now ?? Date.now
  const dir = join(runsDir(repoPath), workspaceId)
  const path = join(dir, 'tasks.json')

  const tasks = new Map<string, Task>()
  let nextTaskNumber = 1

  // One chain serializes the snapshot writes (a later write must never land
  // before an earlier one); `broken` silences persistence after the first
  // failure — the in-memory board stays the working truth, exactly like the
  // journal keeps taking events on a full disk.
  let chain: Promise<unknown> = makeDir(dir, { recursive: true })
  let broken = false

  function snapshot(): TaskBoardState {
    return {
      schemaVersion: 1,
      nextTaskNumber,
      tasks: [...tasks.values()].map((task) => structuredClone(task))
    }
  }

  function persist(): void {
    if (broken) return
    const state = snapshot()
    chain = chain
      .then(async () => {
        // Atomic whole-board snapshot: tmp first, then rename — a crash
        // mid-write leaves the previous tasks.json intact, never a torn one.
        const tmp = `${path}.tmp`
        await write(tmp, JSON.stringify(state, null, 2), 'utf8')
        await move(tmp, path)
      })
      .catch((error: unknown) => {
        if (broken) return
        broken = true
        warn(`[taskBoard] stopped writing ${path} (board stays in memory):`, error)
      })
  }

  /** Store one mutated task — schema-checked, so tasks.json always validates. */
  function accept(task: Task): { ok: true; task: Task } {
    const parsed = taskSchema.parse(task)
    tasks.set(parsed.taskId, parsed)
    persist()
    return { ok: true, task: structuredClone(parsed) }
  }

  /**
   * Would `taskId` depending on `blockedBy` close a cycle? Walk the DAG from
   * the new dependencies; reaching `taskId` again is the cycle. Tombstone
   * edges are skipped — a deleted task blocks nothing, so it cycles nothing.
   */
  function closesCycle(taskId: string, blockedBy: readonly string[]): boolean {
    const seen = new Set<string>()
    const stack = [...blockedBy]
    while (stack.length > 0) {
      const current = stack.pop()!
      if (current === taskId) return true
      if (seen.has(current)) continue
      seen.add(current)
      const task = tasks.get(current)
      if (!task || task.status === 'deleted') continue
      stack.push(...task.blockedBy)
    }
    return false
  }

  /** Shared dependency gate for create and set_dependencies. */
  function checkDependencies(taskId: string, blockedBy: readonly string[]): TaskBoardFailure | undefined {
    for (const dependencyId of blockedBy) {
      const dependency = tasks.get(dependencyId)
      if (!dependency) return { ok: false, error: 'unknown_task', taskId: dependencyId }
      if (dependency.status === 'deleted') {
        return { ok: false, error: 'dependency_deleted', taskId, dependencyId }
      }
    }
    if (closesCycle(taskId, blockedBy)) {
      return { ok: false, error: 'dependency_cycle', taskId, blockedBy: [...blockedBy] }
    }
    return undefined
  }

  return {
    path,

    create(fields) {
      // Tombstones count toward the cap on purpose: the cap bounds the
      // persisted snapshot (and the successor's task_list), not live work.
      if (tasks.size >= TASKS_MAX) return { ok: false, error: 'task_limit', max: TASKS_MAX }
      const taskId = `task-${nextTaskNumber}`
      const blockedBy = [...new Set(fields.blockedBy ?? [])]
      const failed = checkDependencies(taskId, blockedBy)
      if (failed) return failed
      nextTaskNumber += 1
      const at = now()
      return accept({
        taskId,
        revision: 1,
        subject: fields.subject,
        description: fields.description ?? '',
        // A task born with an owner is an assignment — same meaning as claim.
        status: fields.ownerAgentId ? 'in_progress' : 'pending',
        ...(fields.ownerAgentId ? { ownerAgentId: fields.ownerAgentId } : {}),
        blockedBy,
        createdAt: at,
        updatedAt: at
      })
    },

    update(taskId, expectedRevision, action, fields = {}) {
      const current = tasks.get(taskId)
      if (!current) return { ok: false, error: 'unknown_task', taskId }
      // A tombstone accepts nothing — deleted is final (delete is not undoable;
      // recreate the task instead).
      if (current.status === 'deleted') return { ok: false, error: 'task_deleted', taskId }
      // CAS gate before anything else; the CURRENT task rides in the error so
      // the caller reconciles without an extra read.
      if (current.revision !== expectedRevision) {
        return { ok: false, error: 'stale_revision', task: structuredClone(current) }
      }

      const refuse = (): TaskBoardFailure => ({
        ok: false,
        error: 'invalid_transition',
        taskId,
        status: current.status,
        action
      })
      const next: Task = structuredClone(current)
      next.revision += 1
      next.updatedAt = now()

      switch (action) {
        case 'claim': {
          if (!fields.ownerAgentId) {
            return { ok: false, error: 'missing_field', field: 'ownerAgentId', action }
          }
          if (current.status !== 'pending') return refuse()
          next.status = 'in_progress'
          next.ownerAgentId = fields.ownerAgentId
          break
        }
        case 'release': {
          if (current.status !== 'in_progress') return refuse()
          next.status = 'pending'
          delete next.ownerAgentId
          break
        }
        case 'edit': {
          if (fields.subject !== undefined) next.subject = fields.subject
          if (fields.description !== undefined) next.description = fields.description
          break
        }
        case 'set_dependencies': {
          if (!fields.blockedBy) {
            return { ok: false, error: 'missing_field', field: 'blockedBy', action }
          }
          const blockedBy = [...new Set(fields.blockedBy)].filter((id) => id !== taskId)
          const failed = checkDependencies(taskId, blockedBy)
          if (failed) return failed
          next.blockedBy = blockedBy
          break
        }
        case 'complete': {
          if (current.status !== 'pending' && current.status !== 'in_progress') return refuse()
          next.status = 'completed'
          break
        }
        case 'reopen': {
          if (current.status !== 'completed') return refuse()
          next.status = 'pending'
          delete next.ownerAgentId
          break
        }
        case 'delete': {
          // Tombstone, no cascade: other tasks keep their blockedBy reference,
          // and the ready computation ignores it from now on.
          next.status = 'deleted'
          break
        }
        case 'reassign': {
          if (!fields.ownerAgentId) {
            return { ok: false, error: 'missing_field', field: 'ownerAgentId', action }
          }
          if (current.status === 'completed') return refuse()
          next.ownerAgentId = fields.ownerAgentId
          break
        }
      }
      return accept(next)
    },

    get(taskId) {
      const task = tasks.get(taskId)
      return task ? structuredClone(task) : undefined
    },

    list(filter) {
      return [...tasks.values()]
        .filter((task) => (filter?.status ? task.status === filter.status : true))
        .map((task) => structuredClone(task))
    },

    isReady(taskId) {
      const task = tasks.get(taskId)
      if (!task) return false
      return taskReady(task, (id) => tasks.get(id))
    },

    noteReport(agentId, done) {
      let changed = false
      for (const task of tasks.values()) {
        if (task.ownerAgentId !== agentId || task.status === 'deleted') continue
        task.lastReport = {
          status: done.status,
          summary: done.summary.slice(0, MAX_REPORT_SUMMARY),
          ...(done.headSha ? { headSha: done.headSha } : {})
        }
        // A report is a mutation like any other — the CAS token moves so a
        // holder of the old revision reconciles against the fresher task.
        task.revision += 1
        task.updatedAt = now()
        changed = true
      }
      if (changed) persist()
    },

    snapshot,

    seed(board) {
      tasks.clear()
      for (const task of board.tasks) tasks.set(task.taskId, structuredClone(task))
      nextTaskNumber = board.nextTaskNumber
      persist()
    },

    flush() {
      return chain.then(
        () => undefined,
        () => undefined
      )
    }
  }
}
