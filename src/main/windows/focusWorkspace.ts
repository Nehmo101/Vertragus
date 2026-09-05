/**
 * Focus one workspace: hide every other agent's CLI window, bring this
 * workspace's windows forward. {@link presentWorkspaceAgents} also reopens
 * closed windows of still-registered agents and tiles via an injected
 * `layout` — this module stays Electron-free.
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
  /**
   * When false, minimized wanted windows stay minimized (startMinimized:
   * a workspace card must not restore every teammate). Default true.
   */
  restoreMinimized?: boolean
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
  const restoreMinimized = deps.restoreMinimized !== false

  const hidden = new Set<FocusableWindow>()
  for (const target of targets) {
    if (wanted.has(target.agentId)) continue
    if (hidden.has(target.window)) continue
    // Hidden (hide-all): leave alone. Minimized still gets hide() so it
    // drops off the taskbar.
    if (!target.window.isVisible() && !target.window.isMinimized()) continue
    hidden.add(target.window)
    deps.beforeHide?.(target.agentId)
    target.window.hide()
  }

  // Stable caller order: restore + showInactive each, then one focus.
  // Shared parents (tab chrome) surface once.
  let focusTarget: FocusableWindow | undefined
  const shown = new Set<FocusableWindow>()
  for (const agentId of agentIds) {
    const target = targets.find((entry) => entry.agentId === agentId)
    if (!target) continue
    if (shown.has(target.window)) continue
    if (target.window.isMinimized() && !restoreMinimized) continue
    shown.add(target.window)
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

export interface PresentWorkspaceAgentsDeps extends FocusWorkspaceDeps {
  /** True when this agent already has a live CLI window. */
  hasLiveWindow(agentId: string): boolean
  /**
   * Reopen a still-registered agent's window. Skip the call when
   * {@link PresentWorkspaceAgentsDeps.hasLiveWindow} is true.
   */
  reopenClosedWindow(agentId: string): void
  /**
   * When false, skip tiling (startMinimized, tab chrome, or snapToZones off).
   * Default true.
   */
  tile?: boolean
  layout(agentIds: readonly string[]): void
}

/**
 * Reopen closed windows of still-registered agents, hide foreign CLI windows,
 * surface this workspace, and tile into zones when `tile` is not false.
 *
 * Returns false when there is nothing to present (`agentIds` empty — a
 * workspace recorded before its orchestrator exists). Callers fall back to
 * hide-all's snapshot instead of claiming a restore.
 */
export function presentWorkspaceAgents(
  agentIds: readonly string[],
  deps: PresentWorkspaceAgentsDeps
): boolean {
  if (agentIds.length === 0) return false
  for (const agentId of agentIds) {
    if (deps.hasLiveWindow(agentId)) continue
    deps.reopenClosedWindow(agentId)
  }
  focusWorkspaceAgents(agentIds, deps)
  if (deps.tile !== false) deps.layout(agentIds)
  return true
}

/** Production list of every CLI window as focus-workspace targets. */
export function cliFocusTargets(): FocusWorkspaceTarget[] {
  const seen = new Set<object>()
  const targets: FocusWorkspaceTarget[] = []
  for (const { agentId, window } of listCliWindows()) {
    if (seen.has(window)) continue
    seen.add(window)
    targets.push({
      agentId,
      window: window as unknown as FocusableWindow
    })
  }
  return targets
}
