/**
 * Hide-all — one keystroke that clears the screen of agents.
 *
 * Hide is "everything away". Restore is the last selected workspace's agents
 * in their zones (foreign CLI windows stay hidden), not a replay of every
 * window this toggle hid. When `ui.snapToZones` is on (the default), hide
 * still snaps the windows it hid; last-workspace restore tiles through the
 * injected `restoreWorkspace` seam instead:
 *
 * - Only `hide()`. No close, and never `minimize()` / `restore()` — those fire
 *   move events on Windows that live-reflow would read as a user drag.
 *   Positions survive when the snap flag is off; PTYs keep running. Windows
 *   the user already minimized are left alone (same rule as already-hidden
 *   windows: not ours to touch). Editor and settings windows are hidden, never
 *   re-tiled.
 * - **The panel stays.** It is the way back — hiding it would leave the user
 *   with an invisible app and a hotkey they may have mistyped.
 * - Restore: when `restoreWorkspace` returns true, last-workspace agents are
 *   already in their zones; then non-CLI snapshot targets (timelines/editors/
 *   settings) `showInactive()` and focus lands once on that workspace's first
 *   window. When it is absent or returns false, restore falls back to the
 *   snapshot — `showInactive()` in remembered order, then one focus.
 * - An eye click with an empty snapshot and no visible CLI window calls
 *   `restoreWorkspace` instead of recording an empty hide.
 * - Windows hidden (or minimized) by the user BEFORE the toggle stay that
 *   way afterwards — they were not ours to show.
 *
 * The controller is pure bookkeeping over injectable deps (fake windows in
 * the test). `restoreWorkspace` is registered from index.ts through a setter
 * so this module never imports the Electron entry. The global shortcut is
 * an injectable Electron seam so the registration-failure path is testable —
 * that path is the one that must never fail silently.
 */
import { globalShortcut } from 'electron'
import { mainMessages, readLocale } from '@shared/mainMessages'
import { getSettings } from '@main/store/settings'
import { layoutCliWindowsByWorkspace, listCliWindows } from './cliWindow'
import { listProfileEditorWindows } from './profileEditor'
import { listProviderEditorWindows } from './providerEditor'
import { listSettingsWindows } from './settingsWindow'
import { suppressMoveTracking } from './placement'
import { listTimelineWindows } from './timelineWindow'

const AGENT_KEY_PREFIX = 'agent:'

function isCliHideAllKey(key: string): boolean {
  return key.startsWith(AGENT_KEY_PREFIX)
}

/** The slice of BrowserWindow hide-all uses. */
export interface HideableWindow {
  isDestroyed(): boolean
  isVisible(): boolean
  isMinimized(): boolean
  isFocused(): boolean
  hide(): void
  showInactive(): void
  focus(): void
}

export interface HideAllTarget {
  /** Stable id for the log/tests — agent id or editor key. */
  key: string
  window: HideableWindow
}

export interface HideAllDeps {
  /** Every window hide-all may touch, in a stable order. Never the panel. */
  targets(): readonly HideAllTarget[]
  /**
   * CLI keys (`agent:<id>`), immediately before hide/show. Production
   * suppresses move-tracking so hide/show cannot rewrite live-reflow zones.
   */
  beforeNativeVisibility?(key: string): void
  /**
   * CLI windows hide-all just hid or just showed. Production snaps them to
   * role zones when `ui.snapToZones` is on, one workspace at a time.
   */
  snapCliWindows?(keys: readonly string[]): void
  /**
   * Open the last workspace's agents in their zones. Returns false when there
   * is no last workspace (caller falls back to the snapshot). Absent = today's
   * snapshot restore, and an empty-snapshot eye click stays a no-op hide.
   */
  restoreWorkspace?(): boolean
}

export interface HideAllController {
  /** Hide everything, or bring back what this controller hid. */
  toggle(): 'hidden' | 'restored'
  isHidden(): boolean
  /** Forget the remembered set (app shutdown, workspace closed). */
  reset(): void
}

export function createHideAllController(deps: HideAllDeps): HideAllController {
  /** Keys hidden by the last toggle, in the order they were hidden. */
  let hiddenKeys: string[] = []
  let focusedKey: string | undefined

  return {
    isHidden: () => hiddenKeys.length > 0,

    toggle() {
      const targets = deps.targets().filter((target) => !target.window.isDestroyed())

      if (hiddenKeys.length === 0) {
        const noVisibleCli = targets
          .filter((target) => isCliHideAllKey(target.key))
          .every((target) => !target.window.isVisible())
        if (noVisibleCli && deps.restoreWorkspace?.()) {
          return 'restored'
        }

        focusedKey = targets.find((target) => target.window.isFocused())?.key
        const hiddenWindows = new Set<HideableWindow>()
        for (const target of targets) {
          if (hiddenWindows.has(target.window)) continue
          // A window the user had already hidden or minimized is none of ours.
          if (!target.window.isVisible()) continue
          if (target.window.isMinimized()) continue
          hiddenWindows.add(target.window)
          deps.beforeNativeVisibility?.(target.key)
          target.window.hide()
          hiddenKeys.push(target.key)
        }
        deps.snapCliWindows?.(hiddenKeys)
        return 'hidden'
      }

      if (deps.restoreWorkspace?.()) {
        const byKey = new Map(targets.map((target) => [target.key, target.window]))
        for (const key of hiddenKeys) {
          if (isCliHideAllKey(key)) continue
          deps.beforeNativeVisibility?.(key)
          byKey.get(key)?.showInactive()
        }
        // Focus last workspace's first window once — not each restored CLI.
        const firstCli = targets.find(
          (target) => isCliHideAllKey(target.key) && target.window.isVisible()
        )
        firstCli?.window.focus()
        hiddenKeys = []
        focusedKey = undefined
        return 'restored'
      }

      const byKey = new Map(targets.map((target) => [target.key, target.window]))
      for (const key of hiddenKeys) {
        deps.beforeNativeVisibility?.(key)
        byKey.get(key)?.showInactive()
      }
      deps.snapCliWindows?.(hiddenKeys)
      // Focus last and only once — showInactive deliberately does not.
      const focused = focusedKey ? byKey.get(focusedKey) : undefined
      focused?.focus()
      hiddenKeys = []
      focusedKey = undefined
      return 'restored'
    },

    reset() {
      hiddenKeys = []
      focusedKey = undefined
    }
  }
}

// --- production wiring ---------------------------------------------------

/**
 * CLI windows first, then timelines, then open editors, then the settings
 * sheet. The panel is absent by construction: it is the only surface that
 * must survive hide-all. Timelines are `hide()`d, never minimized.
 */
function appTargets(): HideAllTarget[] {
  return [
    ...listCliWindows().map(({ agentId, window }) => ({
      key: `agent:${agentId}`,
      window: window as unknown as HideableWindow
    })),
    ...listTimelineWindows().map(({ workspaceId, window }) => ({
      key: `timeline:${workspaceId}`,
      window: window as unknown as HideableWindow
    })),
    ...listProfileEditorWindows().map(({ key, window }) => ({
      key: `editor:${key}`,
      window: window as unknown as HideableWindow
    })),
    ...listProviderEditorWindows().map(({ key, window }) => ({
      key: `provider:${key}`,
      window: window as unknown as HideableWindow
    })),
    ...listSettingsWindows().map(({ key, window }) => ({
      key: `settings:${key}`,
      window: window as unknown as HideableWindow
    }))
  ]
}

function cliAgentIdFromKey(key: string): string | undefined {
  return isCliHideAllKey(key) ? key.slice(AGENT_KEY_PREFIX.length) : undefined
}

function suppressCliKey(key: string): void {
  const agentId = cliAgentIdFromKey(key)
  if (agentId) suppressMoveTracking(agentId)
}

/** Snap only CLI keys, one workspace at a time. Editors/settings stay put. */
function snapCliKeysIfEnabled(keys: readonly string[]): void {
  let enabled = true
  try {
    enabled = getSettings().ui?.snapToZones !== false
  } catch {
    enabled = true
  }
  if (!enabled) return
  const agentIds: string[] = []
  for (const key of keys) {
    const agentId = cliAgentIdFromKey(key)
    if (agentId) agentIds.push(agentId)
  }
  if (agentIds.length === 0) return
  layoutCliWindowsByWorkspace(agentIds)
}

let controller: HideAllController | undefined
let restoreWorkspaceHook: (() => boolean) | undefined

/**
 * Register last-workspace restore from the Electron entry. A setter, not an
 * import of index.ts — hideAll must not cycle with the app bootstrap.
 */
export function setHideAllRestoreWorkspace(restore: (() => boolean) | undefined): void {
  restoreWorkspaceHook = restore
}

function appController(): HideAllController {
  if (!controller) {
    controller = createHideAllController({
      targets: appTargets,
      beforeNativeVisibility: suppressCliKey,
      snapCliWindows: snapCliKeysIfEnabled,
      restoreWorkspace: () => restoreWorkspaceHook?.() ?? false
    })
  }
  return controller
}

/** Panel eye and global hotkey both land here. */
export function toggleHideAll(): 'hidden' | 'restored' {
  return appController().toggle()
}

export function isEverythingHidden(): boolean {
  return appController().isHidden()
}

/**
 * Drop hide-all's remembered set without showing anything. A workspace click
 * already decided what is visible; the next hide-all must hide that, not
 * restore the previous snapshot.
 */
export function forgetHideAll(): void {
  controller?.reset()
}

// --- the global shortcut -------------------------------------------------

export interface HideAllHotkeyStatus {
  hotkey: string
  registered: boolean
  /** Human-readable reason; shown by the panel when registration failed. */
  error?: string
}

export interface HideAllShortcutDeps {
  hotkey: string
  register(accelerator: string, callback: () => void): boolean
  unregisterAll(): void
  onToggle?: () => void
  /** UI locale for the failure texts; absent = the schema default (German). */
  locale?: string
}

let status: HideAllHotkeyStatus | undefined

/** The last registration attempt, or undefined before the first one. */
export function hideAllHotkeyStatus(): HideAllHotkeyStatus | undefined {
  return status
}

/**
 * Register the configured accelerator. Electron's `register` returns false when
 * another app already owns the combination — and throws on a malformed one, so
 * both are turned into the same visible status instead of an uncaught boot
 * error. The status is what the panel shows; nothing here logs and forgets.
 */
export function registerHideAllShortcut(deps: HideAllShortcutDeps): HideAllHotkeyStatus {
  const hotkey = deps.hotkey.trim()
  const messages = mainMessages(deps.locale)
  deps.unregisterAll()
  if (!hotkey) {
    status = { hotkey, registered: false, error: messages.hotkeyNone }
    return status
  }
  try {
    const ok = deps.register(hotkey, deps.onToggle ?? (() => toggleHideAll()))
    status = ok
      ? { hotkey, registered: true }
      : { hotkey, registered: false, error: messages.hotkeyTaken(hotkey) }
  } catch (error) {
    status = {
      hotkey,
      registered: false,
      error: messages.hotkeyInvalid(
        hotkey,
        error instanceof Error ? error.message : String(error)
      )
    }
  }
  return status
}

/**
 * Swap the live accelerator for a new one: drop the old registration, take the
 * new one, and hand back the status.
 *
 * This is what the settings window calls the moment the hotkey field is saved.
 * It takes effect immediately and on purpose — a hotkey that only works after
 * the next restart is indistinguishable from one that does not work, and the
 * status returned here is what the form shows inline when the combination is
 * malformed or already owned by another app. A rejected accelerator leaves the
 * app with NO hide-all hotkey (the old one is unregistered first); that is the
 * honest outcome, and it is visible instead of silent.
 */
export function reRegisterHideAllShortcut(hotkey: string): HideAllHotkeyStatus {
  return registerHideAllShortcut({
    hotkey,
    register: (accelerator, callback) => globalShortcut.register(accelerator, callback),
    unregisterAll: () => globalShortcut.unregisterAll(),
    locale: readLocale(() => getSettings().ui.locale)
  })
}

/**
 * Production entry: read the accelerator from the settings store and register
 * it. Called once after `app.whenReady()`; safe to call again after the setting
 * changes (it unregisters first).
 */
export function registerAppHideAllShortcut(): HideAllHotkeyStatus {
  let hotkey = ''
  try {
    hotkey = getSettings().hideAllHotkey
  } catch (error) {
    status = {
      hotkey,
      registered: false,
      // Store unreadable → locale unreadable too, so `mainMessages(undefined)`
      // renders the schema-default language on purpose.
      error: mainMessages(undefined).settingsUnreadable(
        error instanceof Error ? error.message : String(error)
      )
    }
    return status
  }
  return reRegisterHideAllShortcut(hotkey)
}

/** Wired to `will-quit`: a leaked global shortcut outlives the process. */
export function unregisterHideAllShortcut(): void {
  globalShortcut.unregisterAll()
  status = undefined
}

/** Test seam. */
export function resetHideAllForTesting(): void {
  controller = undefined
  status = undefined
  restoreWorkspaceHook = undefined
}
