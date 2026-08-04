/**
 * Pure Ableitung der Rail-Kacheln aus dem gespiegelten Store-State: eine Kachel
 * pro Workspace-Profil mit Live-Zähler der laufenden Agenten.
 */
import type { WorkspaceProfile } from '@shared/profile'

interface RailAgent {
  profileId?: string
  status: string
}

interface RailSession {
  profileId: string
  active: boolean
}

export interface RailTile {
  id: string
  name: string
  /** Großbuchstaben-Initial für die kompakte Darstellung. */
  initial: string
  runningAgents: number
  /** Hat dieses Profil eine aktive Workspace-Session? */
  active: boolean
}

export function railTiles(
  profiles: readonly Pick<WorkspaceProfile, 'id' | 'name'>[],
  agents: readonly RailAgent[],
  sessions: readonly RailSession[]
): RailTile[] {
  return profiles.map((profile) => {
    const runningAgents = agents.filter(
      (agent) => agent.profileId === profile.id && agent.status === 'running'
    ).length
    const active = sessions.some((session) => session.profileId === profile.id && session.active)
    return {
      id: profile.id,
      name: profile.name,
      initial: (profile.name.trim().charAt(0) || '?').toUpperCase(),
      runningAgents,
      active
    }
  })
}
