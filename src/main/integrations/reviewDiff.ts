import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { isAbsolute } from 'node:path'
import type { VertragusTask } from '@shared/orchestrator'
import type { TaskReviewDiff } from '@shared/ipc'

const execFileAsync = promisify(execFile)
export const REVIEW_DIFF_LIMIT = 200_000

export function reviewArgs(task: Pick<VertragusTask, 'commit'>): string[] {
  if (task.commit && /^[a-f0-9]{7,64}$/i.test(task.commit)) {
    return ['show', '--format=fuller', '--stat', '--patch', '--no-ext-diff', '--no-color', task.commit, '--']
  }
  return ['diff', '--stat', '--patch', '--no-ext-diff', '--no-color', 'HEAD', '--']
}

export function limitReviewDiff(value: string): { diff: string; truncated: boolean } {
  if (value.length <= REVIEW_DIFF_LIMIT) return { diff: value, truncated: false }
  return {
    diff: `${value.slice(0, REVIEW_DIFF_LIMIT)}\n\n[Diff für die Anzeige gekürzt]`,
    truncated: true
  }
}

export async function loadTaskReviewDiff(task: VertragusTask): Promise<TaskReviewDiff> {
  if (!task.worktree || !isAbsolute(task.worktree)) {
    throw new Error('Für diese Aufgabe ist kein gültiger Vertragus-Worktree verfügbar.')
  }
  try {
    const { stdout, stderr } = await execFileAsync('git', reviewArgs(task), {
      cwd: task.worktree,
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 1_000_000,
      encoding: 'utf8'
    })
    const value = [stdout, stderr].filter(Boolean).join('\n').trim() || 'Keine Änderungen vorhanden.'
    return { taskId: task.id, ...limitReviewDiff(value) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Git-Diff konnte nicht geladen werden: ${message}`)
  }
}
