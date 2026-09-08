/**
 * Last focused (or started) workspace id — main-process memory so hide-all
 * restore and the panel eye can open "that workspace's agents in their zones"
 * without asking the renderer.
 *
 * Recency is most-recent-first. Start, resume and a workspace click push;
 * stop/remove drops that id and falls back to the next still-live entry, or
 * to the most recently started live workspace when recency is empty.
 *
 * Electron-free: plain strings in, plain strings out.
 */

/** Most-recent-first workspace ids. */
export type WorkspaceRecency = readonly string[]

export function lastWorkspaceId(recency: WorkspaceRecency): string | undefined {
  return recency[0]
}

export function rememberWorkspace(recency: WorkspaceRecency, workspaceId: string): string[] {
  const id = workspaceId.trim()
  if (!id) return [...recency]
  return [id, ...recency.filter((entry) => entry !== id)]
}

/**
 * Drop `workspaceId`. Remaining recency is intersected with `liveIds`. When
 * that leaves nothing, fall back to the last entry of `liveIds` (start order,
 * most recently started at the end), or empty.
 */
export function forgetWorkspace(
  recency: WorkspaceRecency,
  workspaceId: string,
  liveIds: readonly string[]
): string[] {
  const live = new Set(liveIds)
  live.delete(workspaceId)
  const kept = recency.filter((id) => id !== workspaceId && live.has(id))
  if (kept.length > 0) return kept
  const remaining = liveIds.filter((id) => id !== workspaceId)
  const newest = remaining[remaining.length - 1]
  return newest ? [newest] : []
}

let recency: string[] = []
let selectedWorkspaceId: string | undefined

export function recordLastWorkspace(workspaceId: string): void {
  if (workspaceId !== getLastWorkspaceId()) selectedWorkspaceId = undefined
  recency = rememberWorkspace(recency, workspaceId)
}

/** An explicit reveal overrides startMinimized for this workspace's later agents. */
export function selectWorkspace(workspaceId: string): void {
  recordLastWorkspace(workspaceId)
  selectedWorkspaceId = workspaceId
}

export function workspaceWindowVisibility(
  workspaceId: string | undefined,
  hidden: boolean
): 'hidden' | 'visible' | 'default' {
  if (hidden) return 'hidden'
  if (!workspaceId) return 'default'
  if (getLastWorkspaceId() && workspaceId !== getLastWorkspaceId()) return 'hidden'
  return selectedWorkspaceId === workspaceId ? 'visible' : 'default'
}

export function forgetLastWorkspace(workspaceId: string, liveIds: readonly string[]): void {
  if (selectedWorkspaceId === workspaceId) selectedWorkspaceId = undefined
  recency = forgetWorkspace(recency, workspaceId, liveIds)
}

export function getLastWorkspaceId(): string | undefined {
  return lastWorkspaceId(recency)
}

/** Test seam. */
export function resetLastWorkspaceForTesting(): void {
  recency = []
  selectedWorkspaceId = undefined
}
