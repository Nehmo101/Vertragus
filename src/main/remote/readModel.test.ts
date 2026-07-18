import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { OrchestratorSnapshot } from '@shared/orchestrator'
import type { DeviceInfo } from '@shared/remote'
import { deriveApprovals, RemoteReadModel, scopeRemoteFrame } from './readModel'

const scopedDevice: DeviceInfo = {
  id: 'device', name: 'Phone', capabilities: ['read'], createdAt: 1,
  actor: { id: 'owner', displayName: 'Owner' },
  scopes: [{ profileId: 'profile-1', sessionIds: ['session-1'], allowGoalSubmit: false }]
}

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

  it('projects broker permissions and filters every frame by exact session scope', () => {
    const input = snapshot()
    input.pendingPermissions = [{
      id: 'permission-1', provider: 'claude', agentId: 'agent-1',
      profileId: 'profile-1', workspaceSessionId: 'session-1', engineId: 'engine-1',
      tool: 'Bash', summary: 'Approval', createdAt: 20, expiresAt: 30
    }]
    expect(deriveApprovals([input])).toContainEqual(expect.objectContaining({ kind: 'tool-permission' }))
    const bus = new EventEmitter()
    const model = new RemoteReadModel(bus)
    model.start()
    bus.emit('snapshot', input)
    bus.emit('snapshot', { ...input, workspaceSessionId: 'other' })
    const frames = model.initialFrames(scopedDevice)
    expect(frames.filter((frame) => frame.type === 'snapshot')).toHaveLength(1)
    expect(frames.find((frame) => frame.type === 'approvals')).toMatchObject({
      approvals: expect.arrayContaining([expect.objectContaining({ kind: 'tool-permission' })])
    })
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

  it('projects budget and provider-limit decisions from the shared snapshot truth', () => {
    const input = snapshot()
    input.pendingPlan = undefined
    input.budget = {
      tokens: 2_000, costUsd: 1.5, caps: { maxTokens: 2_000 }, exceeded: true,
      exceededBy: ['tokens']
    }
    input.tasks = [{
      id: 'limited', title: 'Limited task', role: 'worker', provider: 'codex',
      status: 'error', note: 'Provider rate limit hit', createdAt: 10, finishedAt: 11
    }]
    expect(deriveApprovals([input])).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'budget-exceeded', actions: ['budget.setCaps'] }),
      expect.objectContaining({ kind: 'provider-limit', actions: ['task.fallback', 'run.reset'] })
    ]))
  })

  it('removes host worktree paths from authenticated remote snapshots', () => {
    const input = snapshot()
    input.tasks[0]!.worktree = 'C:\\secret\\orca-worktree'
    input.tasks[0]!.recoveryArtifact = {
      worktree: 'C:\\secret\\recovery', baseCommit: 'a'.repeat(40), changedFiles: ['src/a.ts'],
      statusSummary: ' M src/a.ts', capturedAt: 1
    }
    const scoped = scopeRemoteFrame({ type: 'snapshot', at: 1, snapshot: input }, scopedDevice)
    expect(scoped?.type).toBe('snapshot')
    if (scoped?.type !== 'snapshot') return
    expect(scoped.snapshot.tasks[0]?.worktree).toBeUndefined()
    expect(scoped.snapshot.tasks[0]?.recoveryArtifact?.worktree).toBe('[internal Vertragus worktree]')
    expect(JSON.stringify(scoped)).not.toContain('C:\\secret')
    const approvalFrame = scopeRemoteFrame({
      type: 'approvals', at: 1,
      approvals: [{
        id: 'task', kind: 'task-blocked', profileId: 'profile-1', workspaceSessionId: 'session-1',
        title: 'Blocked', summary: 'Blocked', createdAt: 1, task: input.tasks[0], actions: ['run.reset']
      }]
    }, scopedDevice)
    expect(JSON.stringify(approvalFrame)).not.toContain('C:\\secret')
  })
})
