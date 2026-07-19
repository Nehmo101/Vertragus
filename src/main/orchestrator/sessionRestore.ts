/**
 * Boot- and shutdown-side of session persistence: adopt legacy settings-bag
 * snapshots, rehydrate persisted workspace sessions into the registry, and
 * flush everything during the ordered quit sequence.
 */
import { getProfile } from '@main/config/store'
import { migrateLegacySettingsSnapshots, sessionStore } from '@main/config/sessionStore'
import { workspaceSessions } from '@main/orchestrator/WorkspaceSessionRegistry'
import { agentManager } from '@main/agents/AgentManager'

let lastShutdownClean = true

export interface SessionRestoreResult {
  cleanShutdown: boolean
  restoredSessions: number
}

/**
 * Run once at startup, before IPC handlers register and the main window loads,
 * so the renderer's first workspaceSessions.list() already contains the
 * restored sessions. Restores engine state only — no agent process is spawned.
 */
export function prepareSessionPersistence(): SessionRestoreResult {
  migrateLegacySettingsSnapshots()
  lastShutdownClean = sessionStore.consumeCleanShutdownFlag()
  const restoredSessions = workspaceSessions.rehydrate((profileId) => getProfile(profileId))
  // Crash protection for terminal history: at most one interval is lost.
  agentManager.startResumeStateSweep()
  return { cleanShutdown: lastShutdownClean, restoredSessions }
}

/** Whether the previous run ended with a completed shutdown flush. */
export function lastShutdownWasClean(): boolean {
  return lastShutdownClean
}

/**
 * The persistence part of the quit sequence. Synchronous on purpose: local
 * atomic writes finish before any process termination starts, so even a
 * shutdown-deadline overrun cannot lose orchestrator state.
 */
export function finalizeSessionPersistence(): void {
  agentManager.persistResumeStates()
  workspaceSessions.flushSnapshots()
  sessionStore.markCleanShutdown()
}
