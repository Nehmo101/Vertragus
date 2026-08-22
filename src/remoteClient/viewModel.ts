/**
 * Presentation helpers for the remote client — the same decisions the desktop
 * panel makes (which card is open, which dot pulses, how a status line reads),
 * as plain functions so they unit-test without a DOM.
 */
import type { RemoteAgentSummary, RemoteWorkspaceSummary } from '@shared/remote/protocol'

export function orderWorkspaces(
  workspaces: readonly RemoteWorkspaceSummary[]
): RemoteWorkspaceSummary[] {
  return [...workspaces].sort((a, b) => Number(b.active) - Number(a.active))
}

export function hasActiveWorkspace(workspaces: readonly RemoteWorkspaceSummary[]): boolean {
  return workspaces.some((workspace) => workspace.active)
}

export function endedWorkspaces(
  workspaces: readonly RemoteWorkspaceSummary[]
): RemoteWorkspaceSummary[] {
  return workspaces.filter((workspace) => !workspace.active)
}

export function liveWorkspaces(
  workspaces: readonly RemoteWorkspaceSummary[]
): RemoteWorkspaceSummary[] {
  return workspaces.filter((workspace) => workspace.active)
}

export function agentNeedsAttention(
  agent: Pick<RemoteAgentSummary, 'roleId' | 'pendingQuestion'>
): boolean {
  return agent.roleId !== 'orchestrator' && Boolean(agent.pendingQuestion?.trim())
}

export function workspaceHasWaitingSubagent(
  workspace: Pick<RemoteWorkspaceSummary, 'agents'>
): boolean {
  return workspace.agents.some(agentNeedsAttention)
}

export function workspaceNeedsAttention(
  workspace: Pick<RemoteWorkspaceSummary, 'agents' | 'userQuestion'>
): boolean {
  if (workspace.userQuestion?.question.trim()) return true
  if (workspaceHasWaitingSubagent(workspace)) return true
  return workspace.agents.some(
    (agent) => agent.roleId === 'orchestrator' && Boolean(agent.pendingQuestion?.trim())
  )
}

export function isWorkspaceExpanded(
  workspace: RemoteWorkspaceSummary,
  expanded: Readonly<Record<string, boolean>>
): boolean {
  if (Object.prototype.hasOwnProperty.call(expanded, workspace.workspaceId)) {
    return expanded[workspace.workspaceId] === true
  }
  return workspace.active || workspaceNeedsAttention(workspace)
}

export function workspaceCardClass(workspace: RemoteWorkspaceSummary, expanded: boolean): string {
  const parts = ['card']
  if (!workspace.active) parts.push('inactive')
  if (workspaceNeedsAttention(workspace)) parts.push('needs-attention')
  if (workspace.orchestratorIdle) parts.push('is-idle')
  if (expanded) parts.push('is-expanded')
  return parts.join(' ')
}

export function agentDotKind(
  agent: Pick<RemoteAgentSummary, 'state' | 'roleId'>
): 'working-orchestrator' | 'working' | 'idle' {
  if (agent.state !== 'working') return 'idle'
  return agent.roleId === 'orchestrator' ? 'working-orchestrator' : 'working'
}

export function agentStatusLine(
  agent: Pick<RemoteAgentSummary, 'state' | 'roleLabel' | 'roleId' | 'statusText'>,
  labels: { working: string; waiting: string; stopped: string }
): string {
  const role = agent.roleLabel?.trim() || agent.roleId
  const task = agent.statusText?.trim()
  const state =
    agent.state === 'working'
      ? labels.working
      : agent.state === 'stopped'
        ? labels.stopped
        : labels.waiting
  if (agent.state === 'working') return `${role} · ${task || state}`
  return task ? `${role} · ${state} · ${task}` : `${role} · ${state}`
}

export function workspaceGoalLine(
  workspace: Pick<RemoteWorkspaceSummary, 'active' | 'goalText'>,
  copy: { goal: (goal: string) => string; noGoal: string }
): string | undefined {
  const goal = workspace.goalText?.trim()
  if (goal) return copy.goal(goal)
  return workspace.active ? copy.noGoal : undefined
}
