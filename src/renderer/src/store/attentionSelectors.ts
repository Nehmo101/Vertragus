/**
 * Pure selectors for tray / attention aggregation.
 *
 * Counts distinct profile-workspaces that currently need user feedback,
 * using only fields already present on the renderer app store.
 */
import type { AgentInstanceInfo } from '@shared/agents'
import type { OrchestratorSnapshot, WorkspaceSessionSummary } from '@shared/orchestrator'
import { deriveRemoteApprovals } from '@shared/remote'
import { workspaceUserAttention } from '@renderer/store/useAppStore'

/** Minimal store slice required by {@link selectPendingFeedbackCount}. */
export interface AttentionSelectorState {
  agents: AgentInstanceInfo[]
  orchestrators: Record<string, OrchestratorSnapshot>
  workspaceSessions: WorkspaceSessionSummary[]
}

function snapshotsForWorkspace(
  state: AttentionSelectorState,
  profileId: string,
  workspaceSessionId?: string
): OrchestratorSnapshot[] {
  const knownSessionIds = new Set(
    state.workspaceSessions
      .filter((session) => session.profileId === profileId)
      .map((session) => session.id)
  )

  return Object.entries(state.orchestrators)
    .filter(([key, snapshot]) => {
      if (snapshot.profileId && snapshot.profileId !== profileId) return false
      if (workspaceSessionId) {
        return key === workspaceSessionId || snapshot.workspaceSessionId === workspaceSessionId
      }
      const matchesProfile =
        snapshot.profileId === profileId || (!snapshot.profileId && key === profileId)
      return (
        matchesProfile &&
        (!snapshot.workspaceSessionId || knownSessionIds.has(snapshot.workspaceSessionId))
      )
    })
    .map(([, snapshot]) => snapshot)
}

/**
 * Whether one profile-workspace currently needs user feedback.
 *
 * Signals (existing store fields only):
 * - `workspaceUserAttention` → `orchestrators.*.pendingPlan`,
 *   `orchestrators.*.activity.phase === 'awaiting-review'`,
 *   and `agents` with `status === 'waiting'` (orchestrator / sub)
 * - Mission-Approval inbox via `deriveRemoteApprovals` on scoped snapshots
 *   (`pendingPlan`, `pendingApprovals`, `pendingPermissions`, budget, blocked tasks)
 * - `orchestrators.*.subagentRequests` with `status === 'pending'`
 * - `orchestrators.*.multiAgentRuns` with `status === 'awaiting-review'`
 */
export function workspaceNeedsUserFeedback(
  state: AttentionSelectorState,
  profileId: string,
  workspaceSessionId?: string
): boolean {
  if (workspaceUserAttention(state, profileId, workspaceSessionId) != null) return true

  const snapshots = snapshotsForWorkspace(state, profileId, workspaceSessionId)
  if (
    snapshots.some((snapshot) =>
      (snapshot.subagentRequests ?? []).some((request) => request.status === 'pending')
    )
  ) {
    return true
  }
  if (
    snapshots.some((snapshot) =>
      (snapshot.multiAgentRuns ?? []).some((run) => run.status === 'awaiting-review')
    )
  ) {
    return true
  }

  // MissionApprovalInbox / Sidebar only project session-scoped snapshots.
  const sessionScoped = snapshots.filter(
    (snapshot) => snapshot.profileId && snapshot.workspaceSessionId
  )
  return deriveRemoteApprovals(sessionScoped).length > 0
}

/**
 * Aggregated count of profile-workspaces that need user feedback.
 * Each workspace session counts at most once; profile-level orphans
 * (attention without a live session row) count as one scope each.
 */
export function selectPendingFeedbackCount(state: AttentionSelectorState): number {
  const scopes = new Set<string>()

  for (const session of state.workspaceSessions) {
    if (workspaceNeedsUserFeedback(state, session.profileId, session.id)) {
      scopes.add(`session:${session.id}`)
    }
  }

  const profileIds = new Set<string>()
  for (const agent of state.agents) {
    if (agent.profileId) profileIds.add(agent.profileId)
  }
  for (const snapshot of Object.values(state.orchestrators)) {
    if (snapshot.profileId) profileIds.add(snapshot.profileId)
  }

  for (const profileId of profileIds) {
    // Session rows already cover that profile; only count profile-scoped orphans.
    if (state.workspaceSessions.some((session) => session.profileId === profileId)) continue
    if (workspaceNeedsUserFeedback(state, profileId)) {
      scopes.add(`profile:${profileId}`)
    }
  }

  return scopes.size
}
