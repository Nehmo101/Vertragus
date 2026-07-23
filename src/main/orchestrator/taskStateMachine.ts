import type { TaskStatus, VertragusTask } from '@shared/orchestrator'

/**
 * Explicit task-status transition model.
 *
 * Task objects are shared between the dispatch pipeline, the plan scheduler,
 * cancel/pause commands and late worker judgements. Ad-hoc `task.status = …`
 * writes let a slower actor overwrite a decision a faster one already made —
 * the cancel race (stopped → running after a semaphore wait) was exactly that
 * class of bug. Every status write goes through {@link applyTaskTransition},
 * which refuses transitions the matrix does not allow instead of corrupting
 * the task.
 *
 * Design notes:
 * - `stopped` is absorbing except for the explicit revival to `queued`
 *   (resumeInterruptedTask, plan retries, manual fallback). A late judgement
 *   or lifecycle event can therefore never overwrite a user cancel.
 * - Other terminal states (`success`, `needs-work`, `error`) may be revived to
 *   `queued` (retries) and may be re-graded among each other: gate arbitration
 *   legitimately downgrades a worker "success" to `needs-work` and recovery
 *   adoption upgrades an `error`/`needs-work` verdict after the fact.
 * - Same-status writes are always allowed (idempotent refreshes that only
 *   update the patch fields).
 */
const ALLOWED: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  queued: ['running', 'waiting', 'paused', 'success', 'needs-work', 'error', 'stopped'],
  running: ['queued', 'waiting', 'paused', 'success', 'needs-work', 'error', 'stopped'],
  waiting: ['queued', 'running', 'paused', 'success', 'needs-work', 'error', 'stopped'],
  paused: ['queued', 'running', 'success', 'needs-work', 'error', 'stopped'],
  success: ['queued', 'needs-work', 'error', 'stopped'],
  'needs-work': ['queued', 'success', 'error', 'stopped'],
  error: ['queued', 'success', 'needs-work', 'stopped'],
  stopped: ['queued']
}

export function isAllowedTaskTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return true
  return ALLOWED[from]?.includes(to) ?? false
}

export interface TaskTransitionResult {
  ok: boolean
  from: TaskStatus
}

/**
 * Apply a status transition plus an optional field patch atomically. When the
 * transition is not allowed, neither the status nor the patch is applied and
 * `ok: false` is returned — callers decide whether that is expected (a cancel
 * won the race) or a programming error worth surfacing.
 */
export function applyTaskTransition(
  task: VertragusTask,
  to: TaskStatus,
  patch?: Partial<VertragusTask>
): TaskTransitionResult {
  const from = task.status
  if (!isAllowedTaskTransition(from, to)) return { ok: false, from }
  if (patch) Object.assign(task, patch)
  task.status = to
  return { ok: true, from }
}
