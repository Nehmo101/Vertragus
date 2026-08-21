/**
 * S4: which slice of a run's plan travels to the card, and what the card is
 * allowed to say about the rest.
 *
 * The board allows 200 rows; the workspace summary is re-broadcast on every
 * change and also travels to the phone, so it carries a bounded window. Two
 * things about that window are load-bearing:
 *
 * - the counts are taken over the WHOLE plan, never over the window. A window
 *   is a display decision; "30/45 done" is a fact about the run, and deriving
 *   it from the rows that happened to fit turns a third of an unfinished plan
 *   into "finished".
 * - the window is chosen by what the reader needs, not by creation order. A
 *   run that completes its plan front to back puts every completed task first,
 *   so a blind prefix shows exactly the rows nobody has to act on and hides
 *   every row somebody does.
 */
import type { WorkspaceTaskSummary } from './Workspace'

/** The plan as one card sees it: a window, plus the truth about the whole. */
export interface TaskWindow {
  /** At most `max` rows, in plan order. */
  rows: WorkspaceTaskSummary[]
  /** Rows in the living plan, tombstones already dropped. */
  total: number
  /** Completed rows in the living plan — NOT in {@link rows}. */
  done: number
}

/**
 * What a row costs the reader, lowest first: work in flight, then work still
 * to come, then work that is finished. Only used to decide what fits — the
 * window itself is handed back in plan order, so the card reads like the plan
 * and not like a priority queue.
 */
function keepRank(task: WorkspaceTaskSummary): number {
  if (task.status === 'in_progress') return 0
  if (task.status === 'pending') return 1
  return 2
}

export function taskWindow(
  tasks: readonly WorkspaceTaskSummary[],
  max: number
): TaskWindow {
  const total = tasks.length
  const done = tasks.filter((task) => task.status === 'completed').length
  if (total <= max) return { rows: [...tasks], total, done }
  const kept = tasks
    .map((task, index) => ({ task, index }))
    // Stable sort on the rank alone: within a rank the entries keep plan
    // order, so the cut inside the last rank that fits is still front-to-back.
    .sort((a, b) => keepRank(a.task) - keepRank(b.task) || a.index - b.index)
    .slice(0, max)
    .sort((a, b) => a.index - b.index)
  return { rows: kept.map((entry) => entry.task), total, done }
}
