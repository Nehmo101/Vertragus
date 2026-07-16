import { describe, expect, it } from 'vitest'
import { deriveTaskSummary, TASK_SUMMARY_MAX_LENGTH } from './orchestrator'

describe('deriveTaskSummary', () => {
  it('uses the active goal as a concise single-line summary', () => {
    const summary = deriveTaskSummary({
      goal: { id: 'goal-1', title: '  IPC verdrahten\nund testen  ', active: true },
      activity: {
        phase: 'monitoring',
        summary: 'Überwacht laufende Tasks.',
        details: [],
        updatedAt: 1
      },
      tasks: []
    })

    expect(summary).toBe('IPC verdrahten und testen')
  })

  it('returns undefined when no work is active', () => {
    expect(deriveTaskSummary({ goal: null, tasks: [] })).toBeUndefined()
    expect(deriveTaskSummary({
      goal: { id: 'ready', title: 'Orchestrator aktiv', active: true },
      activity: {
        phase: 'idle',
        summary: 'Wartet auf ein Ziel.',
        details: [],
        updatedAt: 1
      },
      tasks: []
    })).toBeUndefined()
  })

  it('falls back to a live activity summary when no goal title exists', () => {
    expect(deriveTaskSummary({
      goal: null,
      activity: {
        phase: 'planning',
        summary: '  Bereitet den Plan\nfür den Workspace vor. ',
        details: [],
        updatedAt: 1
      },
      tasks: []
    })).toBe('Bereitet den Plan für den Workspace vor.')
  })

  it('ignores inactive and completed work, but bounds an active task fallback', () => {
    expect(deriveTaskSummary({
      goal: { id: 'old', title: 'Fremder abgeschlossener Lauf', active: false },
      activity: {
        phase: 'completed',
        summary: 'Abgeschlossen.',
        details: [],
        updatedAt: 1
      },
      tasks: [{
        id: 'done',
        title: 'Abgeschlossene Aufgabe',
        role: 'worker',
        status: 'success',
        createdAt: 1
      }]
    })).toBeUndefined()

    const summary = deriveTaskSummary({
      goal: { id: 'ready', title: 'Orchestrator aktiv', active: true },
      tasks: [{
        id: 'running',
        title: `Aktive Aufgabe ${'x'.repeat(180)}`,
        role: 'worker',
        status: 'running',
        createdAt: 1
      }]
    })
    expect(summary).toHaveLength(TASK_SUMMARY_MAX_LENGTH)
    expect(summary?.endsWith('…')).toBe(true)
  })
})
