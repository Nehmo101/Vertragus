import type { AgentInstanceInfo } from '@shared/agents'
import type { AgentProviderId } from '@shared/providers'

export interface TeamTaskTarget {
  provider: AgentProviderId
  model: string
  role: string
  profileId?: string
  workspaceSessionId?: string
}

export interface TeamRuntimeState {
  hasPty: boolean
  interactiveUsed: boolean
}

/** Pure eligibility check used before converting a prestarted team pane into a task pane. */
export function isReusableTeamMember(
  info: AgentInstanceInfo,
  target: TeamTaskTarget,
  runtime: TeamRuntimeState
): boolean {
  return (
    info.teamRole === target.role &&
    info.provider === target.provider &&
    info.model === target.model &&
    (!target.profileId || info.profileId === target.profileId) &&
    (!target.workspaceSessionId || info.workspaceSessionId === target.workspaceSessionId) &&
    info.kind === 'sub' &&
    info.mode === 'interactive' &&
    info.status === 'running' &&
    runtime.hasPty &&
    !runtime.interactiveUsed
  )
}

export function agentIdentityInstruction(name: string): string {
  return (
    `Dein Name in Orca-Strator ist ${name}. Verwende genau diesen Namen, damit deine ` +
    'Identität mit dem Namen im Pane-Kopf übereinstimmt.'
  )
}
