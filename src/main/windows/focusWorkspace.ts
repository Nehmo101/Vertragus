/**
 * Focus one workspace: minimize every other agents' CLI window, bring this
 * workspace's windows forward at their existing positions.
 *
 * Deliberately never moves or re-tiles — placement stays whatever the zone
 * layout (or the user) already set. Only minimize / restore / showInactive /
 * focus. Hidden windows (hide-all) and already-minimized foreign windows are
 * left alone: they are not ours to touch.
 *
 * Focus is stolen once, at the end, onto the first workspace window in stable
 * order (orchestrator first when the caller sorts that way) — the same rule
 * as hide-all restore, so four terminals do not fight over the foreground.
 */
import { listCliWindows } from './cliWindow'

/** The slice of BrowserWindow focus-workspace uses. */
export interface FocusableWindow {
  isDestroyed(): boolean
  isVisible(): boolean
  isMinimized(): boolean
  minimize(): void
  restore(): void
  showInactive(): void
  focus(): void
}

export interface FocusWorkspaceTarget {
  agentId: string
  window: FocusableWindow
}

export interface FocusWorkspaceDeps {
  /** Every registered CLI window, in a stable order. */
  windows(): readonly FocusWorkspaceTarget[]
}

/**
 * Minimize foreign CLI windows and surface the ones whose agent ids are in
 * `agentIds`. Empty `agentIds` (unknown workspace) is a no-op — same quiet
 * shrug as {@link focusCliWindow} for a ghost agent.
 */
export function focusWorkspaceAgents(
  agentIds: readonly string[],
  deps: FocusWorkspaceDeps
): void {
  if (agentIds.length === 0) return

  const wanted = new Set(agentIds)
  const targets = deps.windows().filter((target) => !target.window.isDestroyed())

  for (const target of targets) {
    if (wanted.has(target.agentId)) continue
    // Hidden (hide-all) or already minimized: leave alone.
    if (!target.window.isVisible()) continue
    if (target.window.isMinimized()) continue
    target.window.minimize()
  }

  // Stable caller order: restore + showInactive each, then one focus.
  let focusTarget: FocusableWindow | undefined
  for (const agentId of agentIds) {
    const target = targets.find((entry) => entry.agentId === agentId)
    if (!target) continue
    if (target.window.isMinimized()) target.window.restore()
    target.window.showInactive()
    if (!focusTarget) focusTarget = target.window
  }
  focusTarget?.focus()
}

/** Production list of every CLI window as focus-workspace targets. */
export function cliFocusTargets(): FocusWorkspaceTarget[] {
  return listCliWindows().map(({ agentId, window }) => ({
    agentId,
    window: window as unknown as FocusableWindow
  }))
}
