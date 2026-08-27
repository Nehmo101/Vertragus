/**
 * Boot UI on an agent's CLI window.
 *
 * The window opens as soon as the host has a PTY to attach, which is *before*
 * the worktree, MCP attach and first-turn seed finish. Live xterm/session
 * output is visible for every phase except `waiting`; a compact titlebar
 * status names the phase so an empty terminal is not silent. The full
 * greyhound overlay appears only while waiting for a late MCP session
 * (click-through, so a leftover Cursor approval can still be answered).
 *
 * Overlay visibility does not change the seed hold: the first
 * `await_events` turn is still not submitted until the Vertragus MCP
 * session is actually up.
 *
 * Main sends these phase ids over `terminal:boot`; the renderer translates
 * them. `null` means no overlay and no boot status.
 */
export const TERMINAL_BOOT_PHASES = [
  'preparing',
  'worktree',
  'mcp',
  'cli',
  'handshake',
  'waiting'
] as const

export type TerminalBootPhase = (typeof TERMINAL_BOOT_PHASES)[number]

/** True only while waiting for a late MCP session — full greyhound overlay. */
export function bootOverlayVisible(
  phase: TerminalBootPhase | null | undefined
): phase is 'waiting' {
  return phase === 'waiting'
}

/**
 * Compact titlebar phase line while xterm/session is live (every boot phase
 * except `waiting`). `null` / `undefined` show nothing.
 */
export function bootStatusVisible(
  phase: TerminalBootPhase | null | undefined
): phase is Exclude<TerminalBootPhase, 'waiting'> {
  return phase != null && phase !== 'waiting'
}

/** Waiting-for-MCP is click-through so a leftover Cursor approval can be answered. */
export function bootOverlayClickThrough(phase: TerminalBootPhase | null | undefined): boolean {
  return phase === 'waiting'
}

export function isTerminalBootPhase(value: unknown): value is TerminalBootPhase {
  return (
    typeof value === 'string' &&
    (TERMINAL_BOOT_PHASES as readonly string[]).includes(value)
  )
}
