/**
 * Boot overlay on an agent's CLI window.
 *
 * The window opens as soon as the host has a PTY to attach, which is *before*
 * the worktree, MCP attach and first-turn seed finish. The overlay (greyhound
 * + status) sits on top of that window so the user sees progress instead of a
 * CLI that is still loading servers — and so the first `await_events` turn
 * is not submitted until the Vertragus MCP session is actually up.
 *
 * Main sends these phase ids over `terminal:boot`; the renderer translates
 * them. `null` means the overlay is gone.
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

/** True while the CLI window should keep the greyhound overlay up. */
export function bootOverlayVisible(phase: TerminalBootPhase | null | undefined): boolean {
  return phase != null
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
