/**
 * Panel view model — the presentation decisions, as plain functions.
 *
 * The panel's components stay dumb on purpose: everything that could be *wrong*
 * (which dot pulses, what the status line reads, which tooltip a Commedia name
 * gets) lives here, where it is unit-testable without a DOM. The renderer tests
 * run in plain Node, so nothing in this file may touch the document.
 */
import { loreBlurb } from '@shared/lore'
import { ORCHESTRATOR_ROLE_ID } from '@shared/prompts/roles'
import { workspacePlaceBlurb } from '@shared/workspaceNames'
import type { WorkspaceAgentSummary, WorkspaceSummary } from '../../../preload'
import type { Translate } from '../i18n'

/** Dot appearance: bronze pulse for the orchestrator, verdigris for workers. */
export type AgentDotKind = 'working-orchestrator' | 'working' | 'idle'

export function agentDotKind(agent: Pick<WorkspaceAgentSummary, 'state' | 'roleId'>): AgentDotKind {
  if (agent.state !== 'working') return 'idle'
  return agent.roleId === ORCHESTRATOR_ROLE_ID ? 'working-orchestrator' : 'working'
}

export function agentDotClass(agent: Pick<WorkspaceAgentSummary, 'state' | 'roleId'>): string {
  const kind = agentDotKind(agent)
  if (kind === 'working-orchestrator') return 'panel-dot is-working is-orchestrator'
  if (kind === 'working') return 'panel-dot is-working'
  return 'panel-dot is-idle'
}

function defaultStateText(t: Translate, state: WorkspaceAgentSummary['state']): string {
  if (state === 'working') return t('panel.agentWorking')
  if (state === 'stopped') return t('panel.agentStopped')
  return t('panel.agentWaiting')
}

/**
 * The second line of an agent row: "Orchestrator · plant", "Worker · T-142",
 * "Reviewer · wartet". A host that has nothing specific to say still produces a
 * truthful line from the state alone — an empty status reads as "hung".
 *
 * `t` is a parameter rather than a module-level import for the same reason the
 * rest of this file is pure: these functions run in plain Node tests, and a
 * captured singleton would be a language they could never switch.
 */
export function agentStatusLine(
  t: Translate,
  agent: Pick<WorkspaceAgentSummary, 'state' | 'roleId' | 'roleLabel' | 'statusText'>
): string {
  const role = agent.roleLabel?.trim() || agent.roleId
  const note = agent.statusText?.trim() || defaultStateText(t, agent.state)
  return `${role} · ${note}`
}

/** Tooltip for an agent's code-name — who is this figure in the Commedia? */
export function agentTooltip(agent: Pick<WorkspaceAgentSummary, 'name'>): string | undefined {
  return loreBlurb(agent.name)
}

/** Tooltip for a workspace card — what kind of place is this? */
export function workspaceTooltip(workspace: Pick<WorkspaceSummary, 'name'>): string {
  return workspacePlaceBlurb(workspace.name) ?? workspace.name
}

export function workspaceCardClass(workspace: Pick<WorkspaceSummary, 'active'>): string {
  return workspace.active ? 'panel-card is-active' : 'panel-card'
}

export function agentCountLabel(
  t: Translate,
  workspace: Pick<WorkspaceSummary, 'agents'>
): string {
  return t('panel.agentCount', { count: workspace.agents.length })
}

/**
 * A running workspace blocks nothing, but the panel sorts active cards first:
 * a finished workspace stays visible (its windows may still be open) and must
 * not push live work below the fold.
 */
export function orderWorkspaces(workspaces: readonly WorkspaceSummary[]): WorkspaceSummary[] {
  return [...workspaces].sort((a, b) => Number(b.active) - Number(a.active))
}

/** Never swallow a rejected bridge call — the panel shows what went wrong. */
export { errorText } from '../lib/ipcError'
