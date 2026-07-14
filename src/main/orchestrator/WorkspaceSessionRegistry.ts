import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { OrchestratorSnapshot, WorkspaceSessionSummary } from '@shared/orchestrator'
import type { WorkspaceProfile } from '@shared/profile'
import { OrchestratorEngine } from '@main/orchestrator/Engine'

export interface WorkspaceSession {
  id: string
  profileId: string
  profile: WorkspaceProfile
  sequence: number
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
    startedAt: session.startedAt,
    active
  }
}

export class WorkspaceSessionRegistry extends EventEmitter {
  private readonly byProfile = new Map<string, string[]>()
  private readonly activeByProfile = new Map<string, string>()
  private readonly byId = new Map<string, WorkspaceSession>()

  private create(profile: WorkspaceProfile, reset: boolean): WorkspaceSession {
    const snapshot = cloneProfile(profile)
    const sessionId = randomUUID()
    const sessions = this.byProfile.get(snapshot.id) ?? []
    const engine = new OrchestratorEngine({ profile: snapshot, workspaceSessionId: sessionId })
    const session: WorkspaceSession = {
      id: sessionId,
      profileId: snapshot.id,
      profile: snapshot,
      sequence: sessions.length + 1,
      startedAt: Date.now(),
      engine
    }
    engine.on('snapshot', (value: OrchestratorSnapshot) => {
      this.emit('snapshot', value)
    })
    sessions.push(session.id)
    this.byProfile.set(snapshot.id, sessions)
    this.activeByProfile.set(snapshot.id, session.id)
    this.byId.set(session.id, session)
    if (reset) engine.reset()
    this.emit('changed', this.list())
    return session
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

  reset(profile: WorkspaceProfile, sessionId?: string): void {
    this.ensure(profile, sessionId).engine.reset()
  }

  removeSession(sessionId: string): void {
    const session = this.byId.get(sessionId)
    if (!session) return
    session.engine.removeAllListeners()
    session.engine.reset()
    this.byId.delete(sessionId)
    const remaining = (this.byProfile.get(session.profileId) ?? []).filter((id) => id !== sessionId)
    if (remaining.length === 0) {
      this.byProfile.delete(session.profileId)
      this.activeByProfile.delete(session.profileId)
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
