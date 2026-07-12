import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { OrchestratorSnapshot } from '@shared/orchestrator'
import type { WorkspaceProfile } from '@shared/profile'
import { agentManager } from '@main/agents/AgentManager'
import { OrchestratorEngine } from '@main/orchestrator/Engine'

export interface WorkspaceSession {
  id: string
  profileId: string
  profile: WorkspaceProfile
  startedAt: number
  engine: OrchestratorEngine
}

function cloneProfile(profile: WorkspaceProfile): WorkspaceProfile {
  return {
    ...profile,
    agents: profile.agents.map((slot) => ({ ...slot })),
    planner: { ...profile.planner },
    autoPr: {
      ...profile.autoPr,
      qualityGates: [...profile.autoPr.qualityGates],
      labels: [...profile.autoPr.labels],
      reviewers: [...profile.autoPr.reviewers]
    }
  }
}

export class WorkspaceSessionRegistry extends EventEmitter {
  private readonly byProfile = new Map<string, WorkspaceSession>()
  private readonly byId = new Map<string, WorkspaceSession>()

  private create(profile: WorkspaceProfile, reset: boolean): WorkspaceSession {
    const snapshot = cloneProfile(profile)
    const sessionId = randomUUID()
    const engine = new OrchestratorEngine({ profile: snapshot, workspaceSessionId: sessionId })
    const session: WorkspaceSession = {
      id: sessionId,
      profileId: snapshot.id,
      profile: snapshot,
      startedAt: Date.now(),
      engine
    }
    engine.on('snapshot', (value: OrchestratorSnapshot) => {
      this.emit('snapshot', value)
    })
    this.byProfile.set(snapshot.id, session)
    this.byId.set(session.id, session)
    if (reset) engine.reset()
    return session
  }

  ensure(profile: WorkspaceProfile): WorkspaceSession {
    return this.byProfile.get(profile.id) ?? this.create(profile, false)
  }

  start(profile: WorkspaceProfile): WorkspaceSession {
    if (agentManager.anyRunning(profile.id)) {
      throw new Error(`Workspace "${profile.name}" laeuft bereits.`)
    }
    this.remove(profile.id)
    return this.create(profile, true)
  }

  getById(sessionId: string): WorkspaceSession | undefined {
    return this.byId.get(sessionId)
  }

  getByProfile(profileId: string): WorkspaceSession | undefined {
    return this.byProfile.get(profileId)
  }

  snapshot(profile: WorkspaceProfile): OrchestratorSnapshot {
    return this.ensure(profile).engine.snapshot()
  }

  reviewPlan(profile: WorkspaceProfile, approved: boolean): boolean {
    return this.ensure(profile).engine.reviewPlan(approved)
  }

  reset(profile: WorkspaceProfile): void {
    this.ensure(profile).engine.reset()
  }

  remove(profileId: string): void {
    const session = this.byProfile.get(profileId)
    if (!session) return
    session.engine.removeAllListeners()
    session.engine.reset()
    this.byProfile.delete(profileId)
    this.byId.delete(session.id)
  }
}

export const workspaceSessions = new WorkspaceSessionRegistry()
