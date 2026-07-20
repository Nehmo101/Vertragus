/**
 * Boot- and shutdown-side of session persistence: adopt legacy settings-bag
 * snapshots, rehydrate persisted workspace sessions into the registry, flush
 * everything during the ordered quit sequence — and answer the renderer's
 * restart-recovery questions (status, explicit team restart, orphan cleanup).
 */
import type { AgentInstanceInfo } from '@shared/agents'
import type {
  OrphanedWorktreeInfo,
  SessionRestoreStatus,
  StaleSessionInfo,
  ResumableSessionInfo
} from '@shared/sessions'
import { profileRepoLocalPath } from '@shared/profile'
import { getProfile, getSetting, listProfiles } from '@main/config/store'
import { migrateLegacySettingsSnapshots, sessionStore } from '@main/config/sessionStore'
import { workspaceSessions } from '@main/orchestrator/WorkspaceSessionRegistry'
import { agentManager } from '@main/agents/AgentManager'
import {
  currentBranch,
  inventoryWorktrees,
  isOrcaBranch,
  isOrcaWorktreePath,
  rollbackWorktree,
  worktreeSessionDirName
} from '@main/agents/worktree'

/** Sessions without activity for this many days are suggested for cleanup. */
const SESSION_GC_DEFAULT_DAYS = 30

let lastShutdownClean = true
let lastRestoredSessions = 0

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
  lastRestoredSessions = workspaceSessions.rehydrate((profileId) => getProfile(profileId))
  // Crash protection for terminal history: at most one interval is lost.
  agentManager.startResumeStateSweep()
  return { cleanShutdown: lastShutdownClean, restoredSessions: lastRestoredSessions }
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

function configuredGcDays(): number {
  const value = getSetting<number>('sessions.gcDays')
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : SESSION_GC_DEFAULT_DAYS
}

/**
 * Aggregate the restart-recovery picture for the startup banner. Read-only:
 * scans profile repositories for orphaned worktrees, lists restored sessions
 * whose team can be restarted, and suggests stale sessions for cleanup.
 */
export async function getRestoreStatus(): Promise<SessionRestoreStatus> {
  const indexed = sessionStore.listSessions()
  const knownIds = new Set(indexed.map((entry) => entry.id))

  const roots = new Set<string>()
  for (const profile of listProfiles()) {
    for (const dir of [profileRepoLocalPath(profile), profile.workingDir]) {
      if (dir?.trim()) roots.add(dir.trim())
    }
  }
  const orphansByPath = new Map<string, OrphanedWorktreeInfo>()
  for (const root of roots) {
    try {
      for (const entry of await inventoryWorktrees(root, knownIds)) {
        if (entry.owned) continue
        orphansByPath.set(entry.path, {
          path: entry.path,
          sessionId: entry.sessionId,
          agentId: entry.agentId,
          legacy: entry.legacy,
          changedFiles: entry.changedFiles
        })
      }
    } catch (error) {
      console.warn('[Sessions] worktree inventory failed', root, error)
    }
  }

  const cutoff = Date.now() - configuredGcDays() * 86_400_000
  const staleSessions: StaleSessionInfo[] = indexed
    .filter((entry) => entry.updatedAt > 0 && entry.updatedAt < cutoff)
    .map((entry) => ({
      id: entry.id,
      profileId: entry.profileId,
      name: entry.name,
      updatedAt: entry.updatedAt
    }))

  const resumableSessions: ResumableSessionInfo[] = []
  for (const summary of workspaceSessions.list()) {
    if (agentManager.hasAliveSessionAgents(summary.id)) continue
    const interactive = sessionStore
      .readAgentResumeStates(summary.id)
      .filter((state) => state.info.mode === 'interactive')
    if (interactive.length === 0) continue
    resumableSessions.push({
      id: summary.id,
      profileId: summary.profileId,
      name: summary.name,
      agentCount: interactive.length,
      capturedAt: Math.max(...interactive.map((state) => state.capturedAt))
    })
  }

  return {
    cleanShutdown: lastShutdownClean,
    restoredSessions: lastRestoredSessions,
    resumableSessions,
    orphanedWorktrees: [...orphansByPath.values()],
    staleSessions
  }
}

/** Restart a restored session's interactive team from its resume states. */
export async function restartSessionAgents(
  profileId: string,
  sessionId: string
): Promise<AgentInstanceInfo[]> {
  const session = workspaceSessions.getById(sessionId)
  if (!session || session.profileId !== profileId) {
    throw new Error('Workspace-Session nicht gefunden.')
  }
  const states = sessionStore.readAgentResumeStates(sessionId)
  if (states.length === 0) {
    throw new Error('Für diese Session liegen keine gesicherten Agenten-Zustände vor.')
  }
  const spawned = await agentManager.respawnSessionAgents({
    profileId,
    workspaceSessionId: sessionId,
    engineId: session.engine.engineId,
    states
  })
  if (spawned.some((agent) => agent.kind === 'orchestrator')) {
    session.engine.activate(session.profile)
  }
  return spawned
}

/**
 * Discard one orphaned Vertragus worktree (explicit user decision — this
 * throws away uncommitted work). Refuses paths outside the managed namespaces
 * and worktrees that still belong to an indexed session.
 */
export async function discardOrphanWorktree(path: string): Promise<boolean> {
  const trimmed = typeof path === 'string' ? path.trim() : ''
  if (!trimmed || !isOrcaWorktreePath(trimmed)) {
    throw new Error('Pfad ist kein Vertragus-Worktree.')
  }
  const match = trimmed
    .replace(/\\/g, '/')
    .match(/\.(?:vertragus|orca)-worktrees\/([^/]+)\/([^/]+)\/?$/)
  if (!match) throw new Error('Pfad ist kein Vertragus-Worktree.')
  const sessionDir = match[1]
  const owned = sessionStore
    .listSessions()
    .some((entry) => worktreeSessionDirName(entry.id) === sessionDir)
  if (owned) throw new Error('Dieser Worktree gehört zu einer bekannten Session.')
  const branch = await currentBranch(trimmed)
  return rollbackWorktree(trimmed, branch && isOrcaBranch(branch) ? branch : undefined)
}

export interface DiscardOrphansResult {
  discarded: number
  failed: number
}

/**
 * Discard many orphaned worktrees in one explicit user action. Continues after
 * individual failures so a single bad path cannot block a bulk cleanup.
 */
export async function discardOrphanWorktrees(paths: string[]): Promise<DiscardOrphansResult> {
  const unique = [...new Set(paths.map((path) => (typeof path === 'string' ? path.trim() : '')).filter(Boolean))]
  let discarded = 0
  let failed = 0
  for (const path of unique) {
    try {
      if (await discardOrphanWorktree(path)) discarded += 1
      else failed += 1
    } catch {
      failed += 1
    }
  }
  return { discarded, failed }
}
