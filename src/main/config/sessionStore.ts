/**
 * Dedicated per-session persistence: one JSON file per orchestrator snapshot
 * plus a small index, under userData/sessions/. Replaces the settings-bag
 * `orchestratorSnapshot:*` keys — those rewrote the entire settings blob on
 * every throttled snapshot and accumulated as dead keys because the session
 * UUIDs they were keyed on were never persisted.
 *
 * Without a directory (vitest importing main-process modules, or a runtime
 * whose userData path cannot be resolved) the store is inert: writes are
 * dropped and reads return nothing. In-memory state would never survive the
 * process anyway, and an inert singleton keeps unit tests deterministic.
 */
import { app } from 'electron'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { rename as renameAsync, rm as rmAsync, writeFile as writeFileAsync } from 'node:fs/promises'
import { join } from 'node:path'
import type { OrchestratorSnapshot } from '@shared/orchestrator'
import type { AgentResumeState } from '@shared/agents'
import * as configStore from '@main/config/store'

export interface SessionIndexEntry {
  id: string
  profileId: string
  name: string
  sequence: number
  snapshotKey: string
  startedAt: number
  updatedAt: number
}

interface SessionIndexFile {
  version: 1
  /** True only when the previous process finished its shutdown flush. */
  cleanShutdown: boolean
  sessions: SessionIndexEntry[]
}

interface PersistedSnapshotFile {
  version: 1
  key: string
  updatedAt: number
  snapshot: OrchestratorSnapshot
}

interface PersistedAgentStatesFile {
  version: 1
  sessionId: string
  updatedAt: number
  agents: AgentResumeState[]
}

/** The subset the AgentManager persists through (injectable in tests). */
export interface AgentStatePersistence {
  writeAgentResumeStates(sessionId: string, agents: AgentResumeState[]): void
}

/** The subset the OrchestratorEngine persists through (injectable in tests). */
export interface SnapshotPersistence {
  readSnapshot(key: string): OrchestratorSnapshot | undefined
  writeSnapshot(key: string, snapshot: OrchestratorSnapshot): void
}

/** The subset the WorkspaceSessionRegistry depends on (injectable in tests). */
export interface SessionPersistence extends SnapshotPersistence {
  upsertSession(entry: SessionIndexEntry): void
  touchSession(id: string): void
  removeSession(id: string): void
  listSessions(): SessionIndexEntry[]
}

/** Single source of the snapshot key schema (Engine.persistenceKey uses it too). */
export function orchestratorSnapshotKey(profileId?: string, workspaceSessionId?: string): string {
  if (profileId && workspaceSessionId) return `orchestratorSnapshot:${profileId}:${workspaceSessionId}`
  if (profileId) return `orchestratorSnapshot:${profileId}`
  return 'orchestratorSnapshot'
}

/** A session is worth restoring only when it carries a goal or task history. */
export function hasPersistedProgress(snapshot: OrchestratorSnapshot | undefined): boolean {
  if (!snapshot) return false
  return snapshot.goal != null || (Array.isArray(snapshot.tasks) && snapshot.tasks.length > 0)
}

function sanitizeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/g, '_')
}

const EMPTY_INDEX: SessionIndexFile = { version: 1, cleanShutdown: true, sessions: [] }

export class SessionStore implements SessionPersistence {
  /**
   * Latest not-yet-durable payload per target path. Reads consult this first so
   * a write is observable immediately even before it reaches disk; a superseding
   * write simply overwrites the entry, giving last-write-wins coalescing.
   */
  private readonly pending = new Map<string, string>()
  /** Tail of the serialized async write chain per path (one writer per path). */
  private readonly chains = new Map<string, Promise<void>>()
  private tmpCounter = 0

  constructor(private readonly directory?: string) {
    if (directory) mkdirSync(directory, { recursive: true })
  }

  private snapshotPath(key: string): string | undefined {
    return this.directory ? join(this.directory, `${sanitizeKey(key)}.json`) : undefined
  }

  private tmpPath(path: string): string {
    return `${path}.${process.pid}.${this.tmpCounter++}.tmp`
  }

  /**
   * Queue an atomic (temp-file + rename) write off the main thread. Writes to
   * the same path are serialized; only the newest payload is ever written, so
   * bursts of throttled snapshots coalesce into a single flush.
   */
  private writeFileAtomic(path: string, data: string): void {
    this.pending.set(path, data)
    const prev = this.chains.get(path) ?? Promise.resolve()
    const next = prev.then(
      () => this.drainOne(path),
      () => this.drainOne(path)
    )
    this.chains.set(path, next)
    void next.finally(() => {
      if (this.chains.get(path) === next) this.chains.delete(path)
    })
  }

  private async drainOne(path: string): Promise<void> {
    const data = this.pending.get(path)
    if (data === undefined) return // superseded by a delete or an already-drained write
    const tmp = this.tmpPath(path)
    try {
      await writeFileAsync(tmp, data, { encoding: 'utf8', mode: 0o600 })
      // A newer write (or a delete) landed while we were writing: drop this tmp
      // and let the newer payload's own drain win.
      if (this.pending.get(path) !== data) {
        await rmAsync(tmp, { force: true })
        return
      }
      await renameAsync(tmp, path)
      if (this.pending.get(path) === data) this.pending.delete(path)
    } catch (error) {
      console.warn('[SessionStore] async write failed', path, error)
      await rmAsync(tmp, { force: true }).catch(() => {})
    }
  }

  /** Drop any queued write for a path and remove the file synchronously. */
  private removeFile(path: string): void {
    this.pending.delete(path)
    rmSync(path, { force: true })
  }

  /**
   * Resolve once every queued write has reached disk. Used by tests to await
   * durability; safe to call at any time.
   */
  async whenIdle(): Promise<void> {
    while (this.chains.size > 0) {
      await Promise.allSettled([...this.chains.values()])
    }
  }

  /**
   * Force every queued write to disk synchronously. The app-quit flush path is
   * synchronous on purpose (see finalizeSessionPersistence), so this drains the
   * async queue durably before the process can terminate.
   */
  private flushSync(): void {
    for (const [path, data] of this.pending) {
      try {
        const tmp = this.tmpPath(path)
        writeFileSync(tmp, data, { encoding: 'utf8', mode: 0o600 })
        renameSync(tmp, path)
      } catch (error) {
        console.warn('[SessionStore] sync flush failed', path, error)
      }
    }
    // Any in-flight async drain re-checks `pending` after its await and aborts
    // once it finds its payload cleared here, so it cannot overwrite this flush.
    this.pending.clear()
  }

  private readJson<T>(path: string): T | undefined {
    try {
      const queued = this.pending.get(path)
      if (queued !== undefined) return JSON.parse(queued) as T
      if (!existsSync(path)) return undefined
      return JSON.parse(readFileSync(path, 'utf8')) as T
    } catch (error) {
      console.warn('[SessionStore] unreadable file ignored', path, error)
      return undefined
    }
  }

  readSnapshot(key: string): OrchestratorSnapshot | undefined {
    const path = this.snapshotPath(key)
    if (!path) return undefined
    const file = this.readJson<PersistedSnapshotFile>(path)
    // Sanitized file names could collide; the embedded key disambiguates.
    if (!file || file.key !== key) return undefined
    return file.snapshot
  }

  writeSnapshot(key: string, snapshot: OrchestratorSnapshot): void {
    const path = this.snapshotPath(key)
    if (!path) return
    const file: PersistedSnapshotFile = { version: 1, key, updatedAt: Date.now(), snapshot }
    this.writeFileAtomic(path, JSON.stringify(file))
  }

  deleteSnapshot(key: string): void {
    const path = this.snapshotPath(key)
    if (path) this.removeFile(path)
  }

  private agentStatesPath(sessionId: string): string | undefined {
    return this.directory ? join(this.directory, `agents_${sanitizeKey(sessionId)}.json`) : undefined
  }

  readAgentResumeStates(sessionId: string): AgentResumeState[] {
    const path = this.agentStatesPath(sessionId)
    if (!path) return []
    const file = this.readJson<PersistedAgentStatesFile>(path)
    if (!file || file.sessionId !== sessionId || !Array.isArray(file.agents)) return []
    return file.agents
  }

  writeAgentResumeStates(sessionId: string, agents: AgentResumeState[]): void {
    const path = this.agentStatesPath(sessionId)
    if (!path) return
    const file: PersistedAgentStatesFile = {
      version: 1,
      sessionId,
      updatedAt: Date.now(),
      agents
    }
    this.writeFileAtomic(path, JSON.stringify(file))
  }

  deleteAgentResumeStates(sessionId: string): void {
    const path = this.agentStatesPath(sessionId)
    if (path) this.removeFile(path)
  }

  private readIndex(): SessionIndexFile {
    if (!this.directory) return { ...EMPTY_INDEX, sessions: [] }
    const file = this.readJson<SessionIndexFile>(join(this.directory, 'index.json'))
    if (!file || file.version !== 1 || !Array.isArray(file.sessions)) {
      return { ...EMPTY_INDEX, sessions: [] }
    }
    return file
  }

  private writeIndex(index: SessionIndexFile): void {
    if (!this.directory) return
    this.writeFileAtomic(join(this.directory, 'index.json'), JSON.stringify(index))
  }

  listSessions(): SessionIndexEntry[] {
    return this.readIndex().sessions
      .filter((entry) => entry && typeof entry.id === 'string' && typeof entry.snapshotKey === 'string')
      .sort((a, b) => a.startedAt - b.startedAt)
  }

  upsertSession(entry: SessionIndexEntry): void {
    const index = this.readIndex()
    const sessions = index.sessions.filter((existing) => existing.id !== entry.id)
    sessions.push({ ...entry, updatedAt: Date.now() })
    this.writeIndex({ ...index, sessions })
  }

  touchSession(id: string): void {
    const index = this.readIndex()
    const entry = index.sessions.find((existing) => existing.id === id)
    if (!entry) return
    entry.updatedAt = Date.now()
    this.writeIndex(index)
  }

  removeSession(id: string): void {
    const index = this.readIndex()
    const removed = index.sessions.filter((entry) => entry.id === id)
    if (removed.length === 0) return
    this.writeIndex({ ...index, sessions: index.sessions.filter((entry) => entry.id !== id) })
    for (const entry of removed) this.deleteSnapshot(entry.snapshotKey)
    this.deleteAgentResumeStates(id)
  }

  /**
   * Read whether the previous process shut down cleanly, then arm the crash
   * marker for this run. A first launch (no index yet) counts as clean.
   */
  consumeCleanShutdownFlag(): boolean {
    const index = this.readIndex()
    const wasClean = index.cleanShutdown !== false
    // The crash marker must be durable the instant we arm it, or a crash right
    // after boot would masquerade as a clean shutdown — so flush synchronously.
    this.writeIndex({ ...index, cleanShutdown: false })
    this.flushSync()
    return wasClean
  }

  /**
   * Called at the end of a successful shutdown flush. Synchronously durable: it
   * also drains every queued snapshot/agent-state write enqueued earlier in the
   * quit sequence, so the whole shutdown flush lands before the process exits.
   */
  markCleanShutdown(): void {
    this.writeIndex({ ...this.readIndex(), cleanShutdown: true })
    this.flushSync()
  }
}

function resolveSessionsDir(): string | undefined {
  // Vitest imports main-process modules transitively and mocks electron with
  // real-looking paths; the shared singleton must stay inert there so no test
  // ever writes session files into the working directory.
  if (process.env['VITEST']) return undefined
  try {
    return join(app.getPath('userData'), 'sessions')
  } catch {
    return undefined
  }
}

export const sessionStore = new SessionStore(resolveSessionsDir())

/**
 * One-time adoption of legacy settings-bag snapshots: move every
 * `orchestratorSnapshot:*` value into a session file and index the fully
 * qualified ones (profileId + session UUID) so the previous install's last
 * sessions become restorable instead of remaining dead keys.
 */
export function migrateLegacySettingsSnapshots(store: SessionStore = sessionStore): number {
  const keys = configStore.listSettingKeys?.('orchestratorSnapshot') ?? []
  let migrated = 0
  for (const key of keys) {
    const value = configStore.getSetting?.<OrchestratorSnapshot>(key)
    if (value && typeof value === 'object' && store.readSnapshot(key) === undefined) {
      store.writeSnapshot(key, value)
      const [, profileId, sessionId] = key.split(':')
      if (profileId && sessionId && hasPersistedProgress(value)) {
        store.upsertSession({
          id: sessionId,
          profileId,
          name: '',
          sequence: 0,
          snapshotKey: key,
          startedAt: Date.now(),
          updatedAt: Date.now()
        })
      }
      migrated += 1
    }
    configStore.deleteSetting?.(key)
  }
  return migrated
}
