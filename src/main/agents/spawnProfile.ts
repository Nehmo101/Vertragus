/**
 * Spawn orchestrator + subagent team for a workspace profile.
 */
import type { AgentInstanceInfo } from '@shared/agents'
import {
  agentSlotsWithRoles,
  profileRepoLocalPath,
  type WorkspaceProfile
} from '@shared/profile'
import { agentManager } from '@main/agents/AgentManager'
import { workspaceSessions } from '@main/orchestrator/WorkspaceSessionRegistry'

export async function spawnProfileTeam(
  profile: WorkspaceProfile,
  yoloMaster: boolean,
  options?: { resetOrchestrator?: boolean }
): Promise<AgentInstanceInfo[]> {
  await agentManager.removeAll(profile.id)
  const session =
    options?.resetOrchestrator === false
      ? workspaceSessions.ensure(profile)
      : workspaceSessions.start(profile)
  const engine = session.engine
  const workingDir = profileRepoLocalPath(profile) || profile.workingDir
  const spawned: AgentInstanceInfo[] = []

  for (const { slot, role } of agentSlotsWithRoles(profile.agents)) {
    for (let i = 1; i <= slot.count; i++) {
      spawned.push(
        await agentManager.spawn({
          provider: slot.provider,
          model: slot.model,
          modelPreset: slot.modelPreset,
          role: `Subagent · ${slot.role}${slot.count > 1 ? ` #${i}` : ''}`,
          teamRole: role,
          yolo: slot.yolo || yoloMaster,
          workingDir: slot.workingDir || workingDir,
          profileId: profile.id,
          workspaceSessionId: session.id
        })
      )
    }
  }

  if (profile.orchestrator) {
    spawned.unshift(
      await agentManager.spawn({
        provider: profile.orchestrator.provider,
        model: profile.orchestrator.model,
        modelPreset: profile.orchestrator.modelPreset,
        kind: 'orchestrator',
        role: 'Orchestrator · plant & verteilt',
        yolo: yoloMaster,
        workingDir,
        profileId: profile.id,
        workspaceSessionId: session.id
      })
    )
    engine.activate(profile)
  }

  return spawned
}
