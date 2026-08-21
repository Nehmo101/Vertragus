/**
 * Presentation helpers for the remote client — the same decisions the desktop
 * panel makes (which card is open, which dot pulses, how a status line reads),
 * as plain functions so they unit-test without a DOM.
 */
import type { RemoteAgentSummary, RemoteWorkspaceSummary } from '@shared/remote/protocol'

/**
 * Codepoint order on the lowercased text. Deliberately not `localeCompare`:
 * the same list must come out in the same order on the phone and on the
 * desktop, and ICU collation differs between those two engines.
 */
function compareText(a: string, b: string): number {
  const left = a.toLowerCase()
  const right = b.toLowerCase()
  if (left < right) return -1
  return left > right ? 1 : 0
}

/**
 * A total order over the list, not just a partition.
 *
 * `active` alone leaves every live card equal to every other, and `sort` is
 * stable — so equal keys keep the order of the *incoming* array, which is the
 * host's and is re-derived on every `workspaces` push. A card could therefore
 * swap places with its neighbour under a thumb already reaching for it.
 * Sorting on keys the push cannot change (name, then id) means a push may add
 * or remove a row, but never move one.
 */
export function orderWorkspaces(
  workspaces: readonly RemoteWorkspaceSummary[]
): RemoteWorkspaceSummary[] {
  return [...workspaces].sort(
    (a, b) =>
      Number(b.active) - Number(a.active) ||
      compareText(a.name, b.name) ||
      compareText(a.workspaceId, b.workspaceId)
  )
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

/**
 * The explicit expansion map for "expand all" / "collapse all". Written out
 * per workspace rather than kept as one flag because `isWorkspaceExpanded`
 * falls back to the card's own default: an empty map after "collapse all"
 * would re-open every live card on the next push.
 */
export function setAllExpanded(
  workspaces: readonly RemoteWorkspaceSummary[],
  open: boolean
): Record<string, boolean> {
  const next: Record<string, boolean> = {}
  for (const workspace of workspaces) next[workspace.workspaceId] = open
  return next
}

/** Which way the one list-wide toggle should go; an empty list collapses. */
export function everyCardExpanded(
  workspaces: readonly RemoteWorkspaceSummary[],
  expanded: Readonly<Record<string, boolean>>
): boolean {
  return (
    workspaces.length > 0 &&
    workspaces.every((workspace) => isWorkspaceExpanded(workspace, expanded))
  )
}
