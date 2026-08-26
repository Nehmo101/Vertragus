/**
 * How an agent's CLI window paints.
 *
 * Vertragus runs real vendor CLIs in a PTY. Their TUIs disagree wildly —
 * Cursor Agent in particular paints version tips, paste chips and a full
 * worktree path that no other window shows. The **session** surface is a
 * host-chrome overlay (status, branch, event log, follow-up) that looks the
 * same for every provider. The **raw** surface is the vendor TUI unchanged.
 *
 * Permission dialogs still live in the TUI: the title bar peeks at raw, and
 * the waiting-for-MCP boot phase forces raw so a leftover Cursor approval
 * can be clicked. This module is the single authority on the stored default
 * and on that force-raw rule.
 *
 * Deliberately dependency-free (no zod, no DOM): the store validates through
 * it, the renderer decides what to paint, and both halves unit-test in Node.
 */
import type { TerminalBootPhase } from './terminalBoot'

export const CLI_SURFACES = ['session', 'raw'] as const
export type CliSurface = (typeof CLI_SURFACES)[number]

/** New installs, and any store that predates the setting. */
export const DEFAULT_CLI_SURFACE: CliSurface = 'session'

export function isCliSurface(value: unknown): value is CliSurface {
  return value === 'session' || value === 'raw'
}

/**
 * Read anything, answer with a usable surface. Junk and missing values become
 * the default rather than failing a whole settings read.
 */
export function normalizeCliSurface(value: unknown): CliSurface {
  return isCliSurface(value) ? value : DEFAULT_CLI_SURFACE
}

/**
 * What this window should paint right now.
 *
 * `waiting` (MCP not connected) always shows the raw TUI — the boot overlay
 * is click-through in that phase so a leftover Cursor approval can be
 * answered, and covering it with session chrome would hide the prompt.
 * A local title-bar peek wins over the stored default otherwise.
 */
export function effectiveCliSurface(input: {
  setting: CliSurface
  peek?: CliSurface | null
  boot?: TerminalBootPhase | null
}): CliSurface {
  if (input.boot === 'waiting') return 'raw'
  if (isCliSurface(input.peek)) return input.peek
  return normalizeCliSurface(input.setting)
}
