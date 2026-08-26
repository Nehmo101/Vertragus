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
  /**
   * Foreign windows, immediately before `hide()`. Production suppresses
   * move-tracking so hide/show cannot be read as a live-reflow drag.
   */
  beforeHide?(agentId: string): void
  /**
   * Wanted minimized windows, immediately before `restore()`. Production
   * suppresses move-tracking so a delayed restore animation cannot mark the
   * window as user-dragged or overwrite the later zone snap.
   */
  beforeRestore?(agentId: string): void
  /**
   * Wanted windows, immediately before `showInactive()`. Same suppress as
   * hide/restore: Windows may shove the window onto the primary display.
   */
  beforeShow?(agentId: string): void
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
    deps.beforeHide?.(target.agentId)
    target.window.hide()
  }

  // Stable caller order: restore + showInactive each, then one focus.
  let focusTarget: FocusableWindow | undefined
  for (const agentId of agentIds) {
    const target = targets.find((entry) => entry.agentId === agentId)
    if (!target) continue
    if (target.window.isMinimized()) {
      deps.beforeRestore?.(agentId)
      target.window.restore()
    }
    deps.beforeShow?.(agentId)
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
