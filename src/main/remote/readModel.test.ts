import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { OrchestratorSnapshot } from '@shared/orchestrator'
import { deriveApprovals, RemoteReadModel } from './readModel'

function snapshot(): OrchestratorSnapshot {
  return {
    profileId: 'profile-1', workspaceSessionId: 'session-1', goal: null,
    pendingPlan: {
      planId: 'plan-1', usedFallback: false, rejected: false, validationIssues: [],
      plan: { version: 1, goal: 'Ship it', maxParallel: 1, tasks: [] }
    },
    tasks: [{
      id: 'task-1', title: 'Blocked task', role: 'worker', status: 'needs-work',
      blocker: { kind: 'worker', code: 'blocked', summary: 'Need input', details: [], recoverable: true },
      createdAt: 10
    }]
  }
}

describe('RemoteReadModel', () => {
  it('projects plan and blocked-task approvals', () => {
    expect(deriveApprovals([snapshot()])).toEqual([
      expect.objectContaining({ kind: 'task-blocked', id: 'task:session-1:task-1' }),
      expect.objectContaining({ kind: 'plan-review', id: 'plan:session-1:plan-1' })
    ])
  })

  it('preserves engine-owned publication approvals', () => {
    const input = snapshot()
    input.pendingApprovals = [{
      id: 'publication:session-1:plan-1', kind: 'pr-publication',
      profileId: 'profile-1', workspaceSessionId: 'session-1',
      title: 'Publish', summary: 'Ready', createdAt: 12,
      actions: ['publication.approve', 'publication.reject']
    }]
    expect(deriveApprovals([input])).toContainEqual(expect.objectContaining({ kind: 'pr-publication' }))
  })

  it('fans out the exact snapshot from the workspace snapshot bus', () => {
    const bus = new EventEmitter()
    const model = new RemoteReadModel(bus)
    const listener = vi.fn()
    model.subscribe(listener)
    model.start()
    const input = snapshot()
    bus.emit('snapshot', input)
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ type: 'snapshot', snapshot: input }))
    expect(model.initialFrames()).toContainEqual(expect.objectContaining({ type: 'snapshot', snapshot: input }))
    model.stop()
  })
})
