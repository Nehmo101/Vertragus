/**
 * Focus one workspace: hide every other agent's CLI window, bring this
 * workspace's windows forward. Zone re-tiling is the caller's job
 * (`layoutCliWindows`) — this module stays Electron-free.
 *
 * Foreign windows are `hide()`d, never minimized: minimize/restore fires move
 * events on Windows and wrecks bounds (see hideAll.ts). Already-hidden windows
 * stay hidden. Minimized foreign windows are still hidden so they leave the
 * taskbar. PTYs keep running.
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
  hide(): void
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
 * Hide foreign CLI windows and surface the ones whose agent ids are in
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
    // Hidden (hide-all): leave alone. Minimized still gets hide() so it
    // drops off the taskbar.
    if (!target.window.isVisible() && !target.window.isMinimized()) continue
    target.window.hide()
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
