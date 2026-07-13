import { describe, expect, it } from 'vitest'
import type { OrcaTask, OrchestratorSnapshot } from '@shared/orchestrator'
import {
  liveOrchestratorTasks,
  resolveOrchestratorActivity,
  taskActivityText
} from './orchestratorActivity'

function task(patch: Partial<OrcaTask> = {}): OrcaTask {
  return {
    id: 'task-1',
    title: 'Status UI',
    role: 'frontend',
    status: 'running',
    phase: 'working',
    lastAction: 'Prüft die Panel-Struktur',
    createdAt: 100,
    ...patch
  }
}

describe('orchestrator live activity', () => {
  it('prefers an explicit coordinator report over inferred task state', () => {
    const snapshot: OrchestratorSnapshot = {
      goal: { id: 'goal', title: 'Improve status', active: true },
      activity: {
        phase: 'reviewing',
        summary: 'Vergleicht Ergebnisse mit dem Ziel.',
        details: ['Prüft Tests und Blocker.'],
        nextStep: 'Abschlussbericht schreiben.',
        updatedAt: 500
      },
      tasks: [task()]
    }

    expect(resolveOrchestratorActivity(snapshot, 999)).toEqual(snapshot.activity)
  })

  it('derives a truthful monitoring report for old snapshots', () => {
    const snapshot: OrchestratorSnapshot = {
      goal: { id: 'goal', title: 'Improve status', active: true },
      tasks: [
        task({ agentName: 'Legolas' }),
        task({ id: 'task-2', title: 'Tests', status: 'queued', phase: 'queued', role: 'review' })
      ]
    }

    const activity = resolveOrchestratorActivity(snapshot, 999)

    expect(activity.phase).toBe('monitoring')
    expect(activity.summary).toContain('1 laufende Subagents')
    expect(activity.details[0]).toContain('Legolas: Status UI')
    expect(liveOrchestratorTasks(snapshot.tasks)).toHaveLength(2)
  })

  it('formats phase and last action as one concrete worker update', () => {
    expect(taskActivityText(task({ phase: 'testing', lastAction: 'corepack pnpm test' })))
      .toBe('Prüft · corepack pnpm test')
  })
})
