/**
 * Restart-recovery status shared between main and renderer: what the last
 * shutdown looked like, which restored sessions can restart their agents, and
 * which leftovers (orphaned worktrees, stale sessions) await a user decision.
 * Everything here is informational — no destructive action happens without an
 * explicit renderer call.
 */

export interface OrphanedWorktreeInfo {
  path: string
  sessionId: string
  agentId: string
  /** True for pre-rebrand `.orca-worktrees` checkouts. */
  legacy: boolean
  /** Uncommitted changes (git status entries); undefined when git failed. */
  changedFiles?: number
}

/** A persisted session without recent activity, suggested for cleanup. */
export interface StaleSessionInfo {
  id: string
  profileId: string
  name: string
  updatedAt: number
}

/** A restored session whose interactive team can be restarted from resume states. */
export interface ResumableSessionInfo {
  id: string
  profileId: string
  name: string
  /** Interactive agents captured in the resume states. */
  agentCount: number
  capturedAt: number
}

export interface SessionRestoreStatus {
  /** False when the previous run ended without a completed shutdown flush. */
  cleanShutdown: boolean
  /** Sessions rehydrated into the registry at startup. */
  restoredSessions: number
  resumableSessions: ResumableSessionInfo[]
  orphanedWorktrees: OrphanedWorktreeInfo[]
  staleSessions: StaleSessionInfo[]
}
