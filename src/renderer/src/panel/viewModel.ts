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
import type { TokenUsage } from '@shared/schema/events'
import { workspacePlaceBlurb } from '@shared/workspaceNames'
import type {
  WorkspaceAgentSummary,
  WorkspaceSummary,
  WorkspaceTaskSummary
} from '../../../preload'
import type { Locale, Translate } from '../i18n'
import { formatTokenCount, tokenUsageCount } from '../lib/formatTokens'

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
 * A working agent shows the live task. A stopped or still-starting one still
 * shows what it was working on, after the state word — closing the window of a
 * finished worker must not erase the assignment from the row.
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
  const task = agent.statusText?.trim()
  if (agent.state === 'working') {
    return `${role} · ${task || defaultStateText(t, agent.state)}`
  }
  const state = defaultStateText(t, agent.state)
  return task ? `${role} · ${state} · ${task}` : `${role} · ${state}`
}

/**
 * Finished agents whose CLI window is still on screen get an ✕. Closing it
 * leaves the row (and the last task) in place — the window is the thing being
 * dismissed, not the agent.
 */
export function agentTokenLabel(
  t: Translate,
  locale: Locale,
  agent: Pick<WorkspaceAgentSummary, 'tokenUsage'>
): string | undefined {
  const usage = agent.tokenUsage
  if (!usage) return undefined
  const count = formatTokenCount(tokenUsageCount(usage), locale)
  return usage.kind === 'context'
    ? t('panel.agentContextTokens', { count })
    : t('panel.agentTokens', { count })
}

export function agentTokenTooltip(t: Translate, locale: Locale, usage: TokenUsage): string {
  const full = (value: number): string => new Intl.NumberFormat(locale).format(value)
  if (usage.kind === 'context') {
    return t('panel.agentContextTokensTitle', {
      used: full(usage.used),
      window: usage.window !== undefined ? full(usage.window) : '—'
    })
  }
  const parts = [
    t('panel.agentTokensInput', { count: full(usage.input) }),
    t('panel.agentTokensOutput', { count: full(usage.output) })
  ]
  if (usage.cacheRead !== undefined) {
    parts.push(t('panel.agentTokensCacheRead', { count: full(usage.cacheRead) }))
  }
  if (usage.cacheWrite !== undefined) {
    parts.push(t('panel.agentTokensCacheWrite', { count: full(usage.cacheWrite) }))
  }
  return parts.join(' · ')
}

export function agentCanCloseWindow(
  agent: Pick<WorkspaceAgentSummary, 'state' | 'windowOpen'>
): boolean {
  return agent.state === 'stopped' && agent.windowOpen === true
}

/**
 * Hover-card text for an agent's code-name — who is this figure in the
 * Commedia, and what is it working on? The task line comes from the agent's
 * current assignment (`taskText`): a subagent's last start_agent / follow-up,
 * the orchestrator's latest user CLI submit. Undefined when there is neither
 * — a card repeating the bare name would be worse than no card (see
 * {@link workspacePlaceTooltip}).
 *
 * `locale` travels next to `t` for the same reason `t` does (see
 * {@link agentStatusLine}): the blurbs are bilingual data, not i18next keys.
 */
export function agentTooltip(
  t: Translate,
  locale: Locale,
  agent: Pick<WorkspaceAgentSummary, 'name' | 'taskText'>
): string | undefined {
  const blurb = loreBlurb(agent.name, locale)
  const task = agent.taskText?.trim()
  if (!task) return blurb
  const taskLine = t('panel.workspaceTask', { task })
  return blurb ? `${blurb}\n\n${taskLine}` : taskLine
}

/**
 * The mini description of a workspace card — what kind of place is this?
 *
 * Undefined for a name the Commedia roster does not know, and that absence is
 * the point: the card is now a real hover card with the name as its heading,
 * so falling back to the name would pop up a box that repeats the word the
 * user is already pointing at.
 */
export function workspacePlaceTooltip(
  locale: Locale,
  workspace: Pick<WorkspaceSummary, 'name'>
): string | undefined {
  return workspacePlaceBlurb(workspace.name, locale)
}

/**
 * Hover-card text for a workspace — what kind of place is this, and what is
 * the user's goal? The goal line only appears once one was captured; before
 * that the blurb stands alone. The current delegated task does not belong
 * here (that is the agent rows). Undefined when there is neither (see
 * {@link workspacePlaceTooltip} for why an unknown bare name gets no card).
 */
export function workspaceTooltip(
  t: Translate,
  locale: Locale,
  workspace: Pick<WorkspaceSummary, 'name' | 'goalText'>
): string | undefined {
  const blurb = workspacePlaceTooltip(locale, workspace)
  const goal = workspace.goalText?.trim()
  if (!goal) return blurb
  const goalLine = t('panel.workspaceGoal', { goal })
  return blurb ? `${blurb}\n\n${goalLine}` : goalLine
}

/**
 * The goal line of a workspace card (H2). Shown collapsed and expanded — a
 * shut card must still say what the run is for. A delivered goal is quoted;
 * a RUNNING workspace without one says so — "kein Ziel — Orchestrator wartet"
 * is the honest state of a bare Play. A finished workspace without a goal
 * gets no line at all (there is nothing left to wait for).
 */
export function workspaceGoalLine(
  t: Translate,
  workspace: Pick<WorkspaceSummary, 'active' | 'goalText'>
): string | undefined {
  const goal = workspace.goalText?.trim()
  if (goal) return t('panel.workspaceGoal', { goal })
  return workspace.active ? t('panel.noGoal') : undefined
}

/** Host compile preview under the raw goal. Absent when compile is off. */
export function workspaceCompileLine(
  t: Translate,
  workspace: Pick<WorkspaceSummary, 'compiledPreview'>
): string | undefined {
  const preview = workspace.compiledPreview?.trim()
  return preview ? t('panel.compiledPreview', { preview }) : undefined
}

/**
 * C6: the cutover badge. A workspace mid-succession is neither working nor
 * dead — its seat is being replaced — and saying so is what stops the greyed
 * card from reading as "the run is over".
 */
export function workspaceSuccessionLabel(
  t: Translate,
  workspace: Pick<WorkspaceSummary, 'successionInProgress'>
): string | undefined {
  return workspace.successionInProgress ? t('panel.succession') : undefined
}

/**
 * S3: offer the "replace orchestrator" button. Two states earn it — a DEAD
 * orchestrator (the usual reason a human reaches for it: the team is still
 * running, nobody drives the loop, and Stop would throw the run away) and a
 * live one that went silent (C5), where replacing beats waiting. Never while a
 * successor is already spawning: the same click twice is refused by the host
 * anyway, and offering it would read as "it did not work".
 */
export function workspaceCanReplaceOrchestrator(
  workspace: Pick<WorkspaceSummary, 'active' | 'orchestratorIdle' | 'successionInProgress'>
): boolean {
  if (workspace.successionInProgress) return false
  return !workspace.active || workspace.orchestratorIdle === true
}

export function workspaceCardClass(
  workspace: Pick<WorkspaceSummary, 'active' | 'agents' | 'userQuestion'>
): string {
  const parts = ['panel-card']
  if (workspace.active) parts.push('is-active')
  if (workspaceNeedsAttention(workspace)) parts.push('needs-attention')
  return parts.join(' ')
}

/**
 * Soft pulse on the card when the human must answer a question: the
 * orchestrator's `ask_user` ({@link WorkspaceSummary.userQuestion}), an
 * orchestrator PTY ASK (`pendingQuestion` on the orchestrator row), or any
 * agent's `pendingQuestion`. A waiting subagent ALSO blinks on its own row
 * ({@link agentNeedsAttention}) — extra, not instead of the card. Blank
 * text is ignored so a stale empty field cannot light the pulse.
 */
export function workspaceNeedsAttention(
  workspace: Pick<WorkspaceSummary, 'agents' | 'userQuestion'>
): boolean {
  if (workspace.userQuestion?.question.trim()) return true
  return workspace.agents.some((agent) => Boolean(agent.pendingQuestion?.trim()))
}

/** Soft pulse on a subagent row that is parked on an open question. */
export function agentNeedsAttention(
  agent: Pick<WorkspaceAgentSummary, 'roleId' | 'pendingQuestion'>
): boolean {
  return agent.roleId !== ORCHESTRATOR_ROLE_ID && Boolean(agent.pendingQuestion?.trim())
}

/**
 * Collapsed-card hint: a waiting subagent blinks on its own row, but a shut
 * card hides that row. This drives the small pulsing dot in the card head so
 * the user knows the card is worth opening.
 */
export function workspaceHasWaitingSubagent(
  workspace: Pick<WorkspaceSummary, 'agents'>
): boolean {
  return workspace.agents.some((agent) => agentNeedsAttention(agent))
}

export function agentRowClass(
  agent: Pick<WorkspaceAgentSummary, 'roleId' | 'pendingQuestion'>
): string {
  return agentNeedsAttention(agent) ? 'panel-agent needs-attention' : 'panel-agent'
}

/**
 * Collapsed-card count: "2/3 Agenten" — currently working over the roster.
 * Waiting and stopped stay in the denominator; orchestrator and subagents
 * count the same. Pluralization follows the TOTAL (`count`).
 */
export function agentCountLabel(
  t: Translate,
  workspace: Pick<WorkspaceSummary, 'agents'>
): string {
  const working = workspace.agents.filter((agent) => agent.state === 'working').length
  return t('panel.agentCount', { count: workspace.agents.length, working })
}

// --- S4: the task board on the card --------------------------------------

/** One board row, ready to paint. Every decision about it was made here. */
export interface TaskRow {
  taskId: string
  subject: string
  status: WorkspaceTaskSummary['status']
  /** ○ ◐ ✓ — the glyph vocabulary the retro tally already established. */
  glyph: string
  /** Spoken form of the glyph; the glyph itself is decoration for a reader. */
  statusLabel: string
  /**
   * Commedia name of the owner. Absent when the task has none — and also when
   * its owner is no longer in this summary's agent list: a raw agent uuid on a
   * card says less than nothing, and the status glyph still shows it is taken.
   */
  ownerName?: string
  /** Pending with unfinished dependencies. The row is dimmed, not hidden. */
  blocked: boolean
  /** "waiting for task-3" — only on a blocked row. */
  hint?: string
  /** Native tooltip: the full row in one line. */
  title: string
}

/** ○ pending · ◐ in progress · ✓ completed. */
export function taskStatusGlyph(status: WorkspaceTaskSummary['status']): string {
  if (status === 'completed') return '✓'
  if (status === 'in_progress') return '◐'
  return '○'
}

export function taskStatusLabel(t: Translate, status: WorkspaceTaskSummary['status']): string {
  if (status === 'completed') return t('panel.taskCompleted')
  if (status === 'in_progress') return t('panel.taskInProgress')
  return t('panel.taskPending')
}

/**
 * The card's view of the run's plan. `ready` is NOT recomputed here — the host
 * decides readiness over the whole board, and the card only ever sees a capped
 * prefix of it, so a second rule here would disagree with the orchestrator's.
 * What is derived is the *hint*: which dependencies are still open, so a
 * blocked row can name them instead of only looking grey. A dependency the cap
 * cut off counts as open — the honest direction, since the host already said
 * this row is not ready. That reasoning only holds because the host emits LIVE
 * dependencies only (`Workspace.listTasks`): a reference to a deleted task is
 * ignored by the readiness rule, so a hint naming it would name a task that is
 * neither in the plan nor blocking anything.
 */
export function taskRows(
  t: Translate,
  workspace: Pick<WorkspaceSummary, 'tasks' | 'agents'>
): TaskRow[] {
  const tasks = workspace.tasks ?? []
  const completed = new Set(
    tasks.filter((task) => task.status === 'completed').map((task) => task.taskId)
  )
  const nameOf = new Map(workspace.agents.map((agent) => [agent.agentId, agent.name]))
  return tasks.map((task) => {
    const blocked = task.status === 'pending' && !task.ready
    const waitingFor = task.blockedBy.filter((taskId) => !completed.has(taskId))
    const ownerName = task.ownerAgentId ? nameOf.get(task.ownerAgentId) : undefined
    const statusLabel = taskStatusLabel(t, task.status)
    const hint =
      blocked && waitingFor.length > 0
        ? t('panel.taskBlocked', { tasks: waitingFor.join(', ') })
        : undefined
    return {
      taskId: task.taskId,
      subject: task.subject,
      status: task.status,
      glyph: taskStatusGlyph(task.status),
      statusLabel,
      ...(ownerName ? { ownerName } : {}),
      blocked,
      ...(hint ? { hint } : {}),
      title: [
        `${task.taskId}: ${task.subject}`,
        statusLabel,
        ...(ownerName ? [t('panel.taskOwner', { agent: ownerName })] : []),
        ...(hint ? [hint] : [])
      ].join(' · ')
    }
  })
}

export function taskRowClass(row: Pick<TaskRow, 'blocked' | 'status'>): string {
  const parts = ['panel-task-row']
  if (row.blocked) parts.push('is-blocked')
  if (row.status === 'completed') parts.push('is-done')
  return parts.join(' ')
}

/**
 * Section header: "3/7 done" — the plan's progress without opening the box.
 *
 * The numbers come from the HOST, over the whole board. `tasks` is a capped
 * window, so counting it would answer a different question than the one the
 * header asks ("30/30 done" for a run with fifteen open tasks). The array is
 * only the fallback for a summary that predates the counts.
 */
export function taskProgressLabel(
  t: Translate,
  workspace: Pick<WorkspaceSummary, 'tasks' | 'taskTotal' | 'taskDone'>
): string {
  const tasks = workspace.tasks ?? []
  return t('panel.taskProgress', {
    done: workspace.taskDone ?? tasks.filter((task) => task.status === 'completed').length,
    total: workspace.taskTotal ?? tasks.length
  })
}

/**
 * "+15 more" under the last visible row. Undefined when the whole plan fits —
 * truncation the card does not admit to is the reason the progress figure was
 * worth distrusting in the first place.
 */
export function taskOverflowLabel(
  t: Translate,
  workspace: Pick<WorkspaceSummary, 'tasks' | 'taskTotal'>
): string | undefined {
  const shown = workspace.tasks?.length ?? 0
  const total = workspace.taskTotal ?? shown
  return total > shown ? t('panel.taskMore', { count: total - shown }) : undefined
}

/**
 * A running workspace blocks nothing, but the panel sorts active cards first:
 * a finished workspace stays visible (its windows may still be open) and must
 * not push live work below the fold.
 */
export function orderWorkspaces(workspaces: readonly WorkspaceSummary[]): WorkspaceSummary[] {
  return [...workspaces].sort((a, b) => Number(b.active) - Number(a.active))
}

/**
 * How many workspaces sit under each profile — drives the count beside the
 * profile name. Profiles with none are simply absent from the map (the row
 * still renders `0`).
 */
export function workspaceCountByProfile(
  workspaces: readonly Pick<WorkspaceSummary, 'profileId'>[]
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const entry of workspaces) {
    counts.set(entry.profileId, (counts.get(entry.profileId) ?? 0) + 1)
  }
  return counts
}

/**
 * Narrow the workspace list to one profile, or pass everything through when
 * nothing is selected. Expansion / selection helpers consume this filtered
 * list so a hidden card cannot stay "open".
 */
export function filterWorkspaces(
  workspaces: readonly WorkspaceSummary[],
  selectedProfileId: string | null
): WorkspaceSummary[] {
  if (selectedProfileId === null) return [...workspaces]
  return workspaces.filter((entry) => entry.profileId === selectedProfileId)
}

/**
 * Toggle the profile filter. Clicking the active filter clears it; clicking
 * another profile (or the same one when idle) selects it. Zero workspaces does
 * not change the toggle — the empty state is still a truthful filter.
 */
export function nextSelectedProfileId(
  selected: string | null,
  clickedId: string
): string | null {
  return selected === clickedId ? null : clickedId
}

/**
 * Workspace whose CLI windows come forward when the user selects a profile
 * (clicking the name, not toggling the filter off). Prefers an active
 * workspace of that profile, otherwise the first matching card.
 */
export function workspaceIdToFocusForProfile(
  workspaces: readonly Pick<WorkspaceSummary, 'workspaceId' | 'profileId' | 'active'>[],
  profileId: string
): string | null {
  const matching = workspaces.filter((entry) => entry.profileId === profileId)
  return matching.find((entry) => entry.active)?.workspaceId ?? matching[0]?.workspaceId ?? null
}

/**
 * Drop a filter whose profile has disappeared from the list so the UI cannot
 * stick on an invisible selection. A still-present id (even with zero
 * workspaces) is left alone — the user clears it by clicking again.
 */
export function resolveSelectedProfileId(
  profiles: readonly { id: string }[],
  selected: string | null
): string | null {
  if (selected === null) return null
  return profiles.some((entry) => entry.id === selected) ? selected : null
}

/**
 * Selection for which workspace card shows its agents.
 *
 * `undefined` — the user has not clicked yet; follow the active workspace.
 * `null` — the user toggled the open card shut; keep every card collapsed.
 * {@link EXPAND_ALL_WORKSPACES} — every visible card is open.
 * a string — expand that id while it still exists.
 */
export type SelectedWorkspaceId = string | null | undefined

/** Sentinel stored in `selectedWorkspaceId` when the section header opens every card. */
export const EXPAND_ALL_WORKSPACES = '__all__'

/**
 * Which card is effectively expanded. Pure so the panel can stay dumb and the
 * decision is unit-testable without a DOM: disappearances fall back to the
 * active workspace (same as "never clicked"), an explicit collapse stays
 * collapsed, and a still-present selection wins. Expand-all is handled by
 * {@link isWorkspaceExpanded} — this helper still returns a single id.
 */
export function expandedWorkspaceId(
  workspaces: readonly Pick<WorkspaceSummary, 'workspaceId' | 'active'>[],
  selected: SelectedWorkspaceId
): string | null {
  if (selected === null || selected === EXPAND_ALL_WORKSPACES) return null
  if (typeof selected === 'string' && workspaces.some((entry) => entry.workspaceId === selected)) {
    return selected
  }
  return workspaces.find((entry) => entry.active)?.workspaceId ?? null
}

/** Whether one card should list its agents under the current selection. */
export function isWorkspaceExpanded(
  workspaces: readonly Pick<WorkspaceSummary, 'workspaceId' | 'active'>[],
  selected: SelectedWorkspaceId,
  workspaceId: string
): boolean {
  if (selected === EXPAND_ALL_WORKSPACES) return true
  return expandedWorkspaceId(workspaces, selected) === workspaceId
}

/** Section-header chevron: true when every card is open via expand-all. */
export function areAllWorkspacesExpanded(selected: SelectedWorkspaceId): boolean {
  return selected === EXPAND_ALL_WORKSPACES
}

/**
 * Toggle expand-all from the section header. Open → collapse everything;
 * anything else → open everything.
 */
export function nextExpandAllSelection(selected: SelectedWorkspaceId): SelectedWorkspaceId {
  return selected === EXPAND_ALL_WORKSPACES ? null : EXPAND_ALL_WORKSPACES
}

/**
 * Toggle / select from a card-head click. Clicking the already-expanded card
 * collapses it; clicking another selects that one. Expand-all exits into a
 * single-card selection so the click always has a clear next state.
 */
export function nextSelectedWorkspaceId(
  workspaces: readonly Pick<WorkspaceSummary, 'workspaceId' | 'active'>[],
  selected: SelectedWorkspaceId,
  clickedId: string
): SelectedWorkspaceId {
  if (selected === EXPAND_ALL_WORKSPACES) return clickedId
  return expandedWorkspaceId(workspaces, selected) === clickedId ? null : clickedId
}

/**
 * Card-head click should also bring that workspace's CLI windows forward —
 * but only when the click opens/selects the card, never when it collapses,
 * and never for a finished (inactive) workspace.
 */
export function shouldFocusWorkspaceOnToggle(
  nextSelection: SelectedWorkspaceId,
  workspace: Pick<WorkspaceSummary, 'workspaceId' | 'active'>
): boolean {
  return workspace.active && nextSelection === workspace.workspaceId
}

/** Never swallow a rejected bridge call — the panel shows what went wrong. */
export { errorText } from '../lib/ipcError'
