import { describe, expect, it } from 'vitest'
import { taskWindow } from './taskWindow'
import type { WorkspaceTaskSummary } from './Workspace'

function task(
  taskId: string,
  status: WorkspaceTaskSummary['status']
): WorkspaceTaskSummary {
  return { taskId, subject: taskId, status, blockedBy: [], ready: status === 'pending' }
}

describe('taskWindow', () => {
  it('passes a plan that fits through untouched', () => {
    const tasks = [task('task-1', 'completed'), task('task-2', 'pending')]
    expect(taskWindow(tasks, 30)).toEqual({ rows: tasks, total: 2, done: 1 })
  })

  it('counts the WHOLE plan, not the window', () => {
    // The regression: 45 tasks completed front to back, the cap a blind
    // prefix — the card read "30/30 done" over a third of an open plan.
    const tasks = [
      ...Array.from({ length: 30 }, (_, i) => task(`task-${i + 1}`, 'completed')),
      ...Array.from({ length: 15 }, (_, i) => task(`task-${i + 31}`, 'pending'))
    ]
    const plan = taskWindow(tasks, 30)
    expect(plan.total).toBe(45)
    expect(plan.done).toBe(30)
    expect(plan.rows).toHaveLength(30)
  })

  it('keeps unfinished work over finished work when the cap bites', () => {
    const tasks = [
      ...Array.from({ length: 30 }, (_, i) => task(`task-${i + 1}`, 'completed')),
      ...Array.from({ length: 15 }, (_, i) => task(`task-${i + 31}`, 'pending')),
      task('task-46', 'in_progress')
    ]
    const rows = taskWindow(tasks, 30).rows
    // Every open row survives; the completed ones give up the space.
    expect(rows.filter((row) => row.status !== 'completed')).toHaveLength(16)
    expect(rows.map((row) => row.taskId)).toContain('task-46')
    expect(rows.filter((row) => row.status === 'completed')).toHaveLength(14)
  })

  it('hands the window back in plan order, not in priority order', () => {
    const tasks = [
      task('task-1', 'completed'),
      task('task-2', 'pending'),
      task('task-3', 'completed'),
      task('task-4', 'in_progress')
    ]
    // Dropped: task-3, the LAST completed row — but what survives is listed
    // 1, 2, 4, so the card still reads like the plan.
    expect(taskWindow(tasks, 3).rows.map((row) => row.taskId)).toEqual([
      'task-1',
      'task-2',
      'task-4'
    ])
  })

  it('cuts inside a status group front to back', () => {
    const tasks = Array.from({ length: 5 }, (_, i) => task(`task-${i + 1}`, 'pending'))
    expect(taskWindow(tasks, 2).rows.map((row) => row.taskId)).toEqual(['task-1', 'task-2'])
  })

  it('reports an empty plan as empty, not as missing', () => {
    expect(taskWindow([], 30)).toEqual({ rows: [], total: 0, done: 0 })
  })
})
