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
  const session =
    options?.resetOrchestrator === false
      ? workspaceSessions.ensure(profile)
      : workspaceSessions.start(profile)
  const engine = session.engine
  const workingDir = profileRepoLocalPath(profile) || profile.workingDir
  const spawned: AgentInstanceInfo[] = []

  // Spawn the orchestrator FIRST. It is the coordinator, so it must come up
  // reliably and independently of the prewarmed workers. Previously the workers
  // were prewarmed first and the orchestrator last, so any failing worker slot
  // (or an orchestrator spawn error after the workers) aborted the whole team
  // spawn and left the workspace without its orchestrator — visible only in the
  // prewarmed ("fixed") mode, because adaptive prewarms nothing and was already
  // orchestrator-first.
  if (profile.orchestrator) {
    spawned.push(
      await agentManager.spawn({
        provider: profile.orchestrator.provider,
        model: profile.orchestrator.model,
        modelPreset: profile.orchestrator.modelPreset,
        kind: 'orchestrator',
        role: 'Orchestrator · plant & verteilt',
        yolo: yoloMaster,
        workingDir,
        profileId: profile.id,
        workspaceSessionId: session.id,
        engineId: engine.engineId
      })
    )
    engine.activate(session.profile)
  }

  const prewarmWorkers = profile.planner.routingMode !== 'adaptive' || !profile.orchestrator
  for (const { slot, role } of prewarmWorkers ? agentSlotsWithRoles(profile.agents) : []) {
    for (let i = 1; i <= slot.count; i++) {
      try {
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
            workspaceSessionId: session.id,
            engineId: engine.engineId
          })
        )
      } catch (error) {
        // A single failing prewarmed slot must never abort the whole team spawn
        // or prevent the remaining workers from starting. The role stays part of
        // the pool and can still be dispatched on demand later.
        console.warn(`[spawnProfileTeam] Prewarm für Rolle "${role}" fehlgeschlagen`, error)
      }
    }
  }

  return spawned
}
