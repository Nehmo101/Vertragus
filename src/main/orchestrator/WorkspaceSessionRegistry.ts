import { randomInt, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  deriveTaskSummary,
  type OrchestratorSnapshot,
  type WorkspaceSessionSummary
} from '@shared/orchestrator'
import type { WorkspaceProfile } from '@shared/profile'
import {
  WORKSPACE_PLACE_NAMES,
  workspacePlaceName,
  shuffleWorkspacePlaceNames
} from '@shared/workspaceNames'
import { OrchestratorEngine } from '@main/orchestrator/Engine'
import {
  hasPersistedProgress,
  orchestratorSnapshotKey,
  sessionStore,
  type SessionPersistence
} from '@main/config/sessionStore'

export interface WorkspaceSession {
  id: string
  profileId: string
  profile: WorkspaceProfile
  sequence: number
  name: string
  taskSummary: string | undefined
  startedAt: number
  engine: OrchestratorEngine
}

function cloneProfile(profile: WorkspaceProfile): WorkspaceProfile {
  return {
    ...profile,
    orchestrator: profile.orchestrator ? { ...profile.orchestrator } : undefined,
    agents: profile.agents.map((slot) => ({
      ...slot,
      strengths: [...slot.strengths],
      weaknesses: [...slot.weaknesses]
    })),
    planner: { ...profile.planner },
    autoGit: { ...profile.autoGit },
    autoPr: {
      ...profile.autoPr,
      qualityGates: [...profile.autoPr.qualityGates],
      labels: [...profile.autoPr.labels],
      reviewers: [...profile.autoPr.reviewers]
    }
  }
}

function summary(session: WorkspaceSession, active: boolean): WorkspaceSessionSummary {
  return {
    id: session.id,
    profileId: session.profileId,
    profileName: session.profile.name,
    sequence: session.sequence,
    name: session.name || workspacePlaceName(session.sequence),
    taskSummary: session.taskSummary,
    startedAt: session.startedAt,
    active
  }
}

export class WorkspaceSessionRegistry extends EventEmitter {
  private readonly byProfile = new Map<string, string[]>()
  private readonly activeByProfile = new Map<string, string>()
  private readonly byId = new Map<string, WorkspaceSession>()
  private readonly workspaceNameCyclesByProfile = new Map<string, string[][]>()
  private readonly workspaceNameAssignmentCountsByProfile = new Map<string, number>()

  constructor(
    private readonly randomWorkspaceNameIndex: (maxExclusive: number) => number = randomInt,
    private readonly store: SessionPersistence = sessionStore
  ) {
    super()
  }

  private nextWorkspaceName(profileId: string): string {
    const assignment = (this.workspaceNameAssignmentCountsByProfile.get(profileId) ?? 0) + 1
    const cycleIndex = Math.floor((assignment - 1) / WORKSPACE_PLACE_NAMES.length)
    const cycles = this.workspaceNameCyclesByProfile.get(profileId) ?? []
    while (cycles.length <= cycleIndex) {
      cycles.push(shuffleWorkspacePlaceNames(this.randomWorkspaceNameIndex))
    }
    this.workspaceNameCyclesByProfile.set(profileId, cycles)
    this.workspaceNameAssignmentCountsByProfile.set(profileId, assignment)
    return workspacePlaceName(assignment, cycles[cycleIndex])
  }

  /** Next free sequence for a profile — rehydrated sessions may exceed the list length. */
  private nextSequence(profileId: string): number {
    const sessions = this.byProfile.get(profileId) ?? []
    return sessions.reduce(
      (max, id) => Math.max(max, this.byId.get(id)?.sequence ?? 0),
      sessions.length
    ) + 1
  }

  private register(input: {
    id: string
    profile: WorkspaceProfile
    sequence: number
    name: string
    startedAt: number
  }): WorkspaceSession {
    const engine = new OrchestratorEngine({
      profile: input.profile,
      workspaceSessionId: input.id,
      persistence: this.store
    })
    const session: WorkspaceSession = {
      id: input.id,
      profileId: input.profile.id,
      profile: input.profile,
      sequence: input.sequence,
      name: input.name,
      taskSummary: deriveTaskSummary(engine.snapshot()),
      startedAt: input.startedAt,
      engine
    }
    engine.on('snapshot', (value: OrchestratorSnapshot) => {
      this.emit('snapshot', value)
      const taskSummary = deriveTaskSummary(value)
      if (taskSummary !== session.taskSummary) {
        session.taskSummary = taskSummary
        this.store.touchSession(session.id)
        this.emit('changed', this.list())
      }
    })
    const sessions = this.byProfile.get(session.profileId) ?? []
    sessions.push(session.id)
    this.byProfile.set(session.profileId, sessions)
    this.activeByProfile.set(session.profileId, session.id)
    this.byId.set(session.id, session)
    this.store.upsertSession({
      id: session.id,
      profileId: session.profileId,
      name: session.name,
      sequence: session.sequence,
      snapshotKey: orchestratorSnapshotKey(session.profileId, session.id),
      startedAt: session.startedAt,
      updatedAt: session.startedAt
    })
    return session
  }

  private create(profile: WorkspaceProfile, reset: boolean): WorkspaceSession {
    const snapshot = cloneProfile(profile)
    const session = this.register({
      id: randomUUID(),
      profile: snapshot,
      sequence: this.nextSequence(snapshot.id),
      name: this.nextWorkspaceName(snapshot.id),
      startedAt: Date.now()
    })
    if (reset) session.engine.reset()
    this.emit('changed', this.list())
    return session
  }

  /**
   * Recreate persisted sessions at boot so each engine's constructor restore
   * finds its snapshot again (the persistence key embeds the session id).
   * Only sessions with real progress come back; empty or orphaned entries are
   * dropped from the store. No agent process is started here — restarting
   * agents stays an explicit user action.
   */
  rehydrate(resolveProfile: (profileId: string) => WorkspaceProfile | undefined): number {
    let restored = 0
    for (const entry of this.store.listSessions()) {
      if (this.byId.has(entry.id)) continue
      const profile = resolveProfile(entry.profileId)
      const snapshot = this.store.readSnapshot(entry.snapshotKey)
      if (!profile || !hasPersistedProgress(snapshot)) {
        this.store.removeSession(entry.id)
        continue
      }
      this.register({
        id: entry.id,
        profile: cloneProfile(profile),
        sequence: entry.sequence > 0 ? entry.sequence : this.nextSequence(entry.profileId),
        // Migrated legacy entries carry no name; assign one like a fresh session.
        name: entry.name || this.nextWorkspaceName(entry.profileId),
        startedAt: entry.startedAt || Date.now()
      })
      restored += 1
    }
    if (restored > 0) this.emit('changed', this.list())
    return restored
  }

  /** Drain every engine's pending throttled snapshot (ordered shutdown). */
  flushSnapshots(): void {
    for (const session of this.byId.values()) session.engine.flushSnapshot()
  }

  ensure(profile: WorkspaceProfile, sessionId?: string): WorkspaceSession {
    if (sessionId) {
      const requested = this.byId.get(sessionId)
      if (!requested || requested.profileId !== profile.id) {
        throw new Error('Workspace-Session nicht gefunden.')
      }
      return requested
    }
    return this.getByProfile(profile.id) ?? this.create(profile, false)
  }

  /** Every start creates an independent run; existing profile runs remain intact. */
  start(profile: WorkspaceProfile): WorkspaceSession {
    return this.create(profile, true)
  }

  list(profileId?: string): WorkspaceSessionSummary[] {
    return [...this.byId.values()]
      .filter((session) => !profileId || session.profileId === profileId)
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((session) => summary(session, this.activeByProfile.get(session.profileId) === session.id))
  }

  setActive(profileId: string, sessionId: string): WorkspaceSession {
    const session = this.byId.get(sessionId)
    if (!session || session.profileId !== profileId) {
      throw new Error('Workspace-Session gehoert nicht zu diesem Profil.')
    }
    this.activeByProfile.set(profileId, sessionId)
    this.emit('changed', this.list())
    return session
  }

  getById(sessionId: string): WorkspaceSession | undefined {
    return this.byId.get(sessionId)
  }

  getByProfile(profileId: string): WorkspaceSession | undefined {
    const activeId = this.activeByProfile.get(profileId)
    return activeId ? this.byId.get(activeId) : undefined
  }

  snapshot(profile: WorkspaceProfile, sessionId?: string): OrchestratorSnapshot {
    const session = sessionId ? this.ensure(profile, sessionId) : this.getByProfile(profile.id)
    return session?.engine.snapshot() ?? {
      profileId: profile.id,
      goal: null,
      tasks: []
    }
  }

  reviewPlan(profile: WorkspaceProfile, approved: boolean, sessionId?: string): boolean {
    return this.ensure(profile, sessionId).engine.reviewPlan(approved)
  }

  enableAutoMode(profile: WorkspaceProfile, sessionId?: string): boolean {
    return this.setPlannerMode(profile, 'auto', sessionId)
  }

  setPlannerMode(
    profile: WorkspaceProfile,
    mode: WorkspaceProfile['planner']['mode'],
    sessionId?: string
  ): boolean {
    const session = this.ensure(profile, sessionId)
    session.profile.planner = { ...session.profile.planner, mode }
    return session.engine.setPlannerMode(mode)
  }

  /**
   * Propagate the global YOLO master to every live session. Bound profiles are
   * session-start clones, so a UI toggle would otherwise never reach a running
   * engine (Retro Lauf 3). Returns the number of updated sessions.
   */
  setYoloMaster(enabled: boolean): number {
    let updated = 0
    for (const session of this.byId.values()) {
      session.profile.yoloDefault = enabled
      if (session.engine.setYolo(enabled)) updated += 1
    }
    return updated
  }

  reset(profile: WorkspaceProfile, sessionId?: string): void {
    this.ensure(profile, sessionId).engine.reset()
  }

  approvePublication(profile: WorkspaceProfile, planId?: string, sessionId?: string): Promise<boolean> {
    return this.ensure(profile, sessionId).engine.approvePublication(planId)
  }

  rejectPublication(profile: WorkspaceProfile, planId?: string, sessionId?: string): boolean {
    return this.ensure(profile, sessionId).engine.rejectPublication(planId)
  }

  resolvePermission(profile: WorkspaceProfile, permissionId: string, allow: boolean, sessionId?: string): boolean {
    return this.ensure(profile, sessionId).engine.resolvePermission(permissionId, allow)
  }

  setBudgetCaps(
    profile: WorkspaceProfile,
    caps: import('@shared/remote').RemoteBudgetCaps,
    sessionId?: string
  ): import('@shared/remote').RemoteBudgetSnapshot {
    return this.ensure(profile, sessionId).engine.setBudgetCaps(caps)
  }

  pauseTask(profile: WorkspaceProfile, taskId: string, sessionId?: string): Promise<boolean> {
    return this.ensure(profile, sessionId).engine.pauseTask(taskId)
  }

  resumeTask(profile: WorkspaceProfile, taskId: string, sessionId?: string): boolean {
    return this.ensure(profile, sessionId).engine.resumeTask(taskId)
  }

  fallbackTask(profile: WorkspaceProfile, taskId: string, sessionId?: string): Promise<boolean> {
    return this.ensure(profile, sessionId).engine.fallbackTask(taskId)
  }

  replanPending(
    profile: WorkspaceProfile,
    input: { removeTaskIds: string[]; maxParallel?: number },
    sessionId?: string
  ): boolean {
    return this.ensure(profile, sessionId).engine.replanPending(input)
  }

  removeSession(sessionId: string): void {
    const session = this.byId.get(sessionId)
    if (!session) return
    session.engine.dispose()
    this.store.removeSession(sessionId)
    this.byId.delete(sessionId)
    const remaining = (this.byProfile.get(session.profileId) ?? []).filter((id) => id !== sessionId)
    if (remaining.length === 0) {
      this.byProfile.delete(session.profileId)
      this.activeByProfile.delete(session.profileId)
      this.workspaceNameCyclesByProfile.delete(session.profileId)
      this.workspaceNameAssignmentCountsByProfile.delete(session.profileId)
    } else {
      this.byProfile.set(session.profileId, remaining)
      if (this.activeByProfile.get(session.profileId) === sessionId) {
        this.activeByProfile.set(session.profileId, remaining[remaining.length - 1]!)
      }
    }
    this.emit('changed', this.list())
  }

  remove(profileId: string): void {
    for (const sessionId of [...(this.byProfile.get(profileId) ?? [])]) {
      this.removeSession(sessionId)
    }
  }
}

export const workspaceSessions = new WorkspaceSessionRegistry()
