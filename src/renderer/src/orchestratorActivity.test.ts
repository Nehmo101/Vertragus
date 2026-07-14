import { describe, expect, it } from 'vitest'
import type { AgentInstanceInfo } from '@shared/agents'
import type { OrcaTask, OrchestratorSnapshot } from '@shared/orchestrator'
import {
  liveOrchestratorTasks,
  paneReadableSummary,
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

function agent(patch: Partial<AgentInstanceInfo> = {}): AgentInstanceInfo {
  return {
    id: 'agent-1',
    name: 'Boromir',
    provider: 'codex',
    model: '',
    role: 'Subagent · Backend / API',
    kind: 'sub',
    mode: 'interactive',
    yolo: false,
    workingDir: '.',
    status: 'running',
    startedAt: 1,
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

describe('paneReadableSummary', () => {
  it('maps the orchestrator pane to the live coordinator report', () => {
    const snapshot: OrchestratorSnapshot = {
      goal: { id: 'goal', title: 'Improve status', active: true },
      activity: {
        phase: 'monitoring',
        summary: 'Überwacht 2 laufende Subagents.',
        details: ['Legolas: Backend'],
        nextStep: 'Blocker prüfen.',
        updatedAt: 500
      },
      tasks: [task()]
    }

    const summary = paneReadableSummary(agent({ kind: 'orchestrator' }), snapshot, 999)

    expect(summary.phaseLabel).toBe('überwacht')
    expect(summary.headline).toBe('Überwacht 2 laufende Subagents.')
    expect(summary.nextStep).toBe('Blocker prüfen.')
    expect(summary.lines).toEqual(['Legolas: Backend'])
  })

  it('maps a task-bound subagent to its task phase and last action', () => {
    const snapshot: OrchestratorSnapshot = {
      goal: null,
      tasks: [task({ id: 'task-7', phase: 'testing', lastAction: 'corepack pnpm test', note: 'Fast fertig' })]
    }

    const summary = paneReadableSummary(agent({ taskId: 'task-7' }), snapshot, 999)

    expect(summary.phaseLabel).toBe('Prüft')
    expect(summary.headline).toBe('Status UI')
    expect(summary.lines).toEqual(['Zuletzt: corepack pnpm test', 'Fast fertig'])
  })

  it('falls back to a truthful status line for a plain interactive pane', () => {
    const summary = paneReadableSummary(agent({ status: 'running', taskId: undefined }), { goal: null, tasks: [] }, 999)

    expect(summary.phaseLabel).toBe('Arbeitet')
    expect(summary.headline).toContain('Arbeitet interaktiv')
    expect(summary.lines).toEqual([])
  })
})
