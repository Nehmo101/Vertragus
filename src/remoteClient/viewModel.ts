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
 * The order inside one group: keys a push cannot change.
 *
 * `sort` is stable, so rows with equal keys keep the order of the *incoming*
 * array — which is the host's, and is re-derived on every `workspaces` push. A
 * card could therefore swap places with its neighbour under a thumb already
 * reaching for it. Name then id means a push may add or remove a row, but
 * never move one.
 */
function compareWithinGroup(a: RemoteWorkspaceSummary, b: RemoteWorkspaceSummary): number {
  return compareText(a.name, b.name) || compareText(a.workspaceId, b.workspaceId)
}

/**
 * A total order over the list, live first — the order the question inbox reads
 * the run in. The overview's own list does NOT use this: a card there must not
 * move when its run ends, so it groups on `overviewRows`' rule instead.
 */
export function orderWorkspaces(
  workspaces: readonly RemoteWorkspaceSummary[]
): RemoteWorkspaceSummary[] {
  return [...workspaces].sort(
    (a, b) => Number(b.active) - Number(a.active) || compareWithinGroup(a, b)
  )
}

export function hasActiveWorkspace(workspaces: readonly RemoteWorkspaceSummary[]): boolean {
  return workspaces.some((workspace) => workspace.active)
}

// --- the one list --------------------------------------------------------

/**
 * The ids this client has seen running since it was opened.
 *
 * A run ending is the normal way a session finishes — the user taps the
 * orchestrator to WATCH it finish — so `active` flipping to false must not be
 * allowed to move, hide or rebuild that card. This set is what separates "it
 * ended while you were here" from "it was already over when you arrived": the
 * first keeps its place in the list, the second folds into the ended group.
 *
 * Monotonic within the present list, and therefore safe to advance during
 * render — which it must be. Advanced in an effect it would land one commit
 * late, and in that commit the card has already been moved (or unmounted), so
 * the flicker and the lost card state the whole design avoids would happen
 * anyway, once, on every run that ends.
 *
 * Returns the SAME set when nothing changed, so a caller can compare by
 * identity and a push that changed nothing costs no re-render.
 */
export function advanceSeenLive(
  seen: ReadonlySet<string>,
  workspaces: readonly RemoteWorkspaceSummary[]
): ReadonlySet<string> {
  const present = new Set(workspaces.map((workspace) => workspace.workspaceId))
  const next = new Set<string>()
  // Pruned to the pushed list: a workspace the host has forgotten takes its
  // memory with it, so a recycled id cannot inherit a place it never had.
  for (const id of seen) if (present.has(id)) next.add(id)
  for (const workspace of workspaces) if (workspace.active) next.add(workspace.workspaceId)
  if (next.size === seen.size && [...next].every((id) => seen.has(id))) return seen
  return next
}

export type OverviewRow =
  | {
      kind: 'workspace'
      key: string
      workspace: RemoteWorkspaceSummary
      /** Ended while this client was watching — the card says so and stays. */
      justEnded: boolean
    }
  | { kind: 'ended-divider'; key: string; count: number }

/** The key the divider always carries, so it is never confused for a card. */
const ENDED_DIVIDER_KEY = 'ended-divider'

/**
 * The overview as ONE keyed list.
 *
 * This is the fix for "a run that ends while I am in its terminal throws my
 * place away". React reconciles each child *slot* separately, so the old
 * `{live.map(card)}{divider}{ended.map(card)}` shape meant a workspace
 * crossing from `live` to `ended` was unmounted from one slot and mounted
 * into another: a new component instance, with the card's open answers, its
 * stop confirmation and its task board all reset — and, with the ended group
 * collapsed, no card at all, a shorter document, and a scroll offset the
 * browser then clamps. Keys cannot help across slots; one array is what makes
 * them work. The divider is a keyed member of that same array for the same
 * reason.
 *
 * The grouping key is "active OR seen running here", not `active`, so the
 * crossing does not reorder the row either: it keeps the position it held
 * while it was live, and carries `justEnded` so the card can say what
 * happened rather than quietly changing colour.
 */
export function overviewRows(
  workspaces: readonly RemoteWorkspaceSummary[],
  seenLive: ReadonlySet<string>,
  showEnded: boolean
): OverviewRow[] {
  const kept: RemoteWorkspaceSummary[] = []
  const folded: RemoteWorkspaceSummary[] = []
  for (const workspace of workspaces) {
    const inPlace = workspace.active || seenLive.has(workspace.workspaceId)
    ;(inPlace ? kept : folded).push(workspace)
  }
  kept.sort(compareWithinGroup)
  folded.sort(compareWithinGroup)
  const row =
    (inPlace: boolean) =>
    (workspace: RemoteWorkspaceSummary): OverviewRow => ({
      kind: 'workspace',
      key: workspace.workspaceId,
      workspace,
      // Only in the kept group: a run that was already over when the client
      // opened did not end "just now" for this user, and saying so would make
      // the notice worthless the first time they saw it be wrong.
      justEnded: inPlace && !workspace.active
    })
  const rows: OverviewRow[] = kept.map(row(true))
  if (folded.length > 0) {
    rows.push({ kind: 'ended-divider', key: ENDED_DIVIDER_KEY, count: folded.length })
    if (showEnded) rows.push(...folded.map(row(false)))
  }
  return rows
}

/** The cards the list-wide expand/collapse control may speak for. */
export function rowWorkspaces(rows: readonly OverviewRow[]): RemoteWorkspaceSummary[] {
  return rows.flatMap((entry) => (entry.kind === 'workspace' ? [entry.workspace] : []))
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

/**
 * `justEnded` is not decoration: without it the DEFAULT flips from open to
 * shut the moment a run ends, so a user who never touched the card watches it
 * fold itself away while they are reading it. A run that ended under this
 * client keeps the card it had.
 */
export function isWorkspaceExpanded(
  workspace: RemoteWorkspaceSummary,
  expanded: Readonly<Record<string, boolean>>,
  justEnded = false
): boolean {
  if (Object.prototype.hasOwnProperty.call(expanded, workspace.workspaceId)) {
    return expanded[workspace.workspaceId] === true
  }
  return workspace.active || justEnded || workspaceNeedsAttention(workspace)
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

/**
 * Which way the one list-wide toggle should go; an empty list collapses. Reads
 * the rows rather than the workspaces so it asks the same question of each
 * card that the card itself answers — `justEnded` included.
 */
export function everyCardExpanded(
  rows: readonly OverviewRow[],
  expanded: Readonly<Record<string, boolean>>
): boolean {
  const cards = rows.filter((row) => row.kind === 'workspace')
  return (
    cards.length > 0 &&
    cards.every((row) => isWorkspaceExpanded(row.workspace, expanded, row.justEnded))
  )
}

// --- the start form ------------------------------------------------------

/**
 * Whether the start form stands open.
 *
 * Three inputs, in the order that respects the user: their own decision if
 * they made one, then the text they have already typed, then the default. The
 * middle rule is not a nicety — `hasLiveRun` flips when a workspace is started
 * from the DESKTOP, and without it a form the user is halfway through typing
 * into would fold shut under their thumb because someone else did something in
 * another room.
 */
export function startFormOpen(
  openedByUser: boolean | null,
  hasLiveRun: boolean,
  hasGoalDraft: boolean
): boolean {
  if (openedByUser !== null) return openedByUser
  if (hasGoalDraft) return true
  return !hasLiveRun
}

/**
 * The profile the picker should show after a `profiles:list`.
 *
 * Keeping the current id blindly outlives the profile itself: delete it on the
 * desktop and the `<select>` has no matching option, shows the first one, and
 * starts — or fails with a raw gateway error — against an id the user cannot
 * see. A selection that no longer exists is not a selection.
 */
export function keepSelectedProfile(
  current: string,
  profiles: readonly { id: string }[]
): string {
  if (profiles.some((profile) => profile.id === current)) return current
  return profiles[0]?.id ?? ''
}

// --- values from the wire ------------------------------------------------

/**
 * A colour hex, or nothing.
 *
 * `roleColor` arrives over the socket and is written into a `--role` custom
 * property, which CSS then substitutes into `background`. Custom properties
 * are token streams, not colours: an unvalidated value closes the declaration
 * it lands in and opens whatever it likes after it, so the one place a remote
 * string reaches the style attribute is the one place that has to be a
 * whitelist rather than a filter. Undefined lets the sheet's own
 * `var(--role, …)` fallback stand.
 */
const ROLE_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i

export function safeRoleColor(raw: string | undefined): string | undefined {
  const value = raw?.trim()
  return value && ROLE_COLOR.test(value) ? value : undefined
}
