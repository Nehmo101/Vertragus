import { describe, expect, it } from 'vitest'
import type { OrchestratorSnapshot } from '@shared/orchestrator'
import { snapshotThreadEntries } from './OrchestratorThread'

describe('snapshotThreadEntries', () => {
  it('orders structured activity, tasks and findings chronologically', () => {
    const snapshot: OrchestratorSnapshot = {
      goal: { id: 'goal-1', title: 'Canvas bauen', active: true },
      activity: { phase: 'monitoring', summary: 'Prüft Tests', details: ['Vitest'], updatedAt: 30 },
      tasks: [{
        id: 'task-1', planId: 'plan-1', title: 'Composer', role: 'frontend', status: 'running',
        phase: 'testing', createdAt: 10, lastHeartbeatAt: 20
      }],
      findings: [{ id: 'finding-1', taskId: 'task-1', kind: 'interface', title: 'API', detail: 'send()', createdAt: 40 }]
    }

    expect(snapshotThreadEntries(snapshot).map((entry) => entry.tone)).toEqual(['goal', 'task', 'activity', 'finding'])
  })

  it('never consumes terminal or ANSI scrollback', () => {
    const snapshot = {
      goal: null,
      tasks: [],
      activity: { phase: 'working', summary: 'Strukturierte Meldung', details: [], updatedAt: 1 },
      terminal: '\u001b[31mSECRET\u001b[0m'
    } as unknown as OrchestratorSnapshot

    expect(JSON.stringify(snapshotThreadEntries(snapshot))).not.toContain('SECRET')
    expect(snapshotThreadEntries(snapshot)[0]?.title).toBe('Strukturierte Meldung')
  })
})
