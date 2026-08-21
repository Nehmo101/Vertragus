/**
 * The run's task board, reduced to rows a card can draw.
 *
 * `RemoteWorkspaceSummary.tasks` has travelled over the wire since S4 and the
 * phone threw it away — which meant the one screen that answers "what is this
 * run actually doing" could only show a single `taskText` line. The board
 * answers it properly: what is in flight, what is ready to be picked up, what
 * is waiting on what, and who owns it.
 *
 * The owner arrives as an agent id and is resolved here against the same
 * `agents` array the card already renders, so the board speaks Commedia names
 * like the rest of the screen. An id with no agent behind it (the agent
 * stopped and left the summary) yields no owner line rather than a raw id.
 */
import type { RemoteAgentSummary, RemoteTaskSummary } from '@shared/remote/protocol'

/** Drives the row's colour; not a status, because 'pending' has three faces. */
export type TaskTone = 'in-progress' | 'ready' | 'blocked' | 'pending' | 'done'

export interface TaskRow {
  taskId: string
  subject: string
  tone: TaskTone
  statusLabel: string
  /** "ready" / "waiting on n tasks"; absent when the status says it all. */
  readinessLabel?: string
  ownerLabel?: string
}

export interface TaskBoardCopy {
  taskPending: string
  taskInProgress: string
  taskCompleted: string
  taskReady: string
  taskBlocked: (count: number) => string
  taskOwner: (name: string) => string
}

/** In-flight first, then what can be started, then what cannot, then done. */
const TONE_ORDER: readonly TaskTone[] = ['in-progress', 'ready', 'blocked', 'pending', 'done']

function toneOf(task: RemoteTaskSummary): TaskTone {
  if (task.status === 'completed') return 'done'
  if (task.status === 'in_progress') return 'in-progress'
  if (task.ready) return 'ready'
  return task.blockedBy.length > 0 ? 'blocked' : 'pending'
}

function statusLabel(task: RemoteTaskSummary, copy: TaskBoardCopy): string {
  if (task.status === 'completed') return copy.taskCompleted
  if (task.status === 'in_progress') return copy.taskInProgress
  return copy.taskPending
}

/**
 * How many blockers are actually still open. The wire carries every blocker
 * the plan declared, including the ones already finished, so counting
 * `blockedBy` would tell a user waiting on one task that it waits on four.
 * Falls back to the declared count if the board disagrees with itself (a
 * blocker id the summary no longer carries) — a blocked row must never claim
 * to be waiting on nothing.
 */
function openBlockerCount(
  task: RemoteTaskSummary,
  byId: ReadonlyMap<string, RemoteTaskSummary>
): number {
  const open = task.blockedBy.filter((id) => byId.get(id)?.status !== 'completed').length
  return open || task.blockedBy.length
}

export function taskRows(
  tasks: readonly RemoteTaskSummary[] | undefined,
  agents: readonly RemoteAgentSummary[],
  copy: TaskBoardCopy
): TaskRow[] {
  if (!tasks || tasks.length === 0) return []
  const byId = new Map(tasks.map((task) => [task.taskId, task]))
  const names = new Map(agents.map((agent) => [agent.agentId, agent.name]))
  const rows = tasks.map((task) => {
    const tone = toneOf(task)
    const owner = task.ownerAgentId ? names.get(task.ownerAgentId) : undefined
    return {
      taskId: task.taskId,
      subject: task.subject,
      tone,
      statusLabel: statusLabel(task, copy),
      readinessLabel:
        tone === 'ready'
          ? copy.taskReady
          : tone === 'blocked'
            ? copy.taskBlocked(openBlockerCount(task, byId))
            : undefined,
      ownerLabel: owner ? copy.taskOwner(owner) : undefined
    }
  })
  // Stable within a tone, so a push that only flips one task's status moves
  // that one row and leaves the rest under the thumb where they were.
  return rows.sort((a, b) => TONE_ORDER.indexOf(a.tone) - TONE_ORDER.indexOf(b.tone))
}

/** Rows the card would draw — what the "show tasks (n)" toggle counts. */
export function taskBoardSize(tasks: readonly RemoteTaskSummary[] | undefined): number {
  return tasks?.length ?? 0
}
