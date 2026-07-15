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
  options?: { resetOrchestrator?: boolean; workingDirOverride?: string }
): Promise<AgentInstanceInfo[]> {
  // Adaptive profiles start their workers later through the orchestrator engine.
  // Persist the global switch in this run's profile snapshot so those delayed
  // workers inherit the same no-prompts policy as agents spawned right now.
  const sessionProfile = yoloMaster && !profile.yoloDefault
    ? { ...profile, yoloDefault: true }
    : profile
  const session =
    options?.resetOrchestrator === false
      ? workspaceSessions.ensure(sessionProfile)
      : workspaceSessions.start(sessionProfile)
  const engine = session.engine
  const runtimeProfile = session.profile
  const workingDir =
    options?.workingDirOverride?.trim() || profileRepoLocalPath(runtimeProfile) || runtimeProfile.workingDir
  const spawned: AgentInstanceInfo[] = []

  const prewarmWorkers = runtimeProfile.planner.routingMode !== 'adaptive' || !runtimeProfile.orchestrator
  for (const { slot, role } of prewarmWorkers ? agentSlotsWithRoles(runtimeProfile.agents) : []) {
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
          profileId: runtimeProfile.id,
          workspaceSessionId: session.id,
          engineId: engine.engineId
        })
      )
    }
  }

  if (runtimeProfile.orchestrator) {
    spawned.unshift(
      await agentManager.spawn({
        provider: runtimeProfile.orchestrator.provider,
        model: runtimeProfile.orchestrator.model,
        modelPreset: runtimeProfile.orchestrator.modelPreset,
        kind: 'orchestrator',
        role: 'Orchestrator · plant & verteilt',
        yolo: yoloMaster,
        workingDir,
        profileId: runtimeProfile.id,
        workspaceSessionId: session.id,
        engineId: engine.engineId
      })
    )
    engine.activate(runtimeProfile)
  }

  return spawned
}
