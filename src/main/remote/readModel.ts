import type { EventEmitter } from 'node:events'
import type { OrcaTask, OrchestratorSnapshot } from '@shared/orchestrator'
import {
  deriveRemoteApprovals,
  type ApprovalItem,
  type DeviceInfo,
  type RemoteEventFrame
} from '@shared/remote'

export interface SnapshotBus extends EventEmitter {
  on(event: 'snapshot', listener: (snapshot: OrchestratorSnapshot) => void): this
  off(event: 'snapshot', listener: (snapshot: OrchestratorSnapshot) => void): this
}

export function deriveApprovals(snapshots: Iterable<OrchestratorSnapshot>): ApprovalItem[] {
  return deriveRemoteApprovals(snapshots)
}

function canReadSession(device: DeviceInfo, profileId?: string, sessionId?: string): boolean {
  if (!profileId || !sessionId) return false
  return Boolean(device.scopes.find((scope) =>
    scope.profileId === profileId && scope.sessionIds.includes(sessionId)
  ))
}

function remoteTask(task: OrcaTask): OrcaTask {
  return {
    ...task,
    worktree: undefined,
    recoveryArtifact: task.recoveryArtifact
      ? { ...task.recoveryArtifact, worktree: '[internal Orca worktree]' }
      : undefined
  }
}

export function scopeRemoteFrame(frame: RemoteEventFrame, device: DeviceInfo): RemoteEventFrame | undefined {
  if (frame.type === 'snapshot') {
    if (!canReadSession(device, frame.snapshot.profileId, frame.snapshot.workspaceSessionId)) return undefined
    return {
      ...frame,
      snapshot: {
        ...frame.snapshot,
        tasks: frame.snapshot.tasks.map(remoteTask)
      }
    }
  }
  if (frame.type === 'approvals') {
    return {
      ...frame,
      approvals: frame.approvals
        .filter((approval) => canReadSession(device, approval.profileId, approval.workspaceSessionId))
        .map((approval) => ({
          ...approval,
          task: approval.task ? remoteTask(approval.task) : undefined
        }))
    }
  }
  return frame
}

export class RemoteReadModel {
  private readonly snapshots = new Map<string, OrchestratorSnapshot>()
  private readonly listeners = new Set<(frame: RemoteEventFrame) => void>()
  private started = false
  private readonly onSnapshot = (snapshot: OrchestratorSnapshot): void => {
    const key = snapshot.workspaceSessionId ?? snapshot.profileId
    if (!key) return
    this.snapshots.set(key, snapshot)
    this.publish({ type: 'snapshot', at: Date.now(), snapshot })
    this.publish({ type: 'approvals', at: Date.now(), approvals: deriveApprovals(this.snapshots.values()) })
  }

  constructor(private readonly bus: SnapshotBus) {}

  start(): void {
    if (this.started) return
    this.started = true
    this.bus.on('snapshot', this.onSnapshot)
  }

  stop(): void {
    if (!this.started) return
    this.started = false
    this.bus.off('snapshot', this.onSnapshot)
    this.listeners.clear()
  }

  seed(snapshot: OrchestratorSnapshot): void {
    this.onSnapshot(snapshot)
  }

  initialFrames(device?: DeviceInfo): RemoteEventFrame[] {
    const at = Date.now()
    const frames: RemoteEventFrame[] = [
      ...[...this.snapshots.values()].map((snapshot): RemoteEventFrame => ({ type: 'snapshot', at, snapshot })),
      { type: 'approvals', at, approvals: deriveApprovals(this.snapshots.values()) }
    ]
    return device
      ? frames.flatMap((frame) => {
          const scoped = scopeRemoteFrame(frame, device)
          return scoped ? [scoped] : []
        })
      : frames
  }

  subscribe(listener: (frame: RemoteEventFrame) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private publish(frame: RemoteEventFrame): void {
    for (const listener of this.listeners) listener(frame)
  }
}
