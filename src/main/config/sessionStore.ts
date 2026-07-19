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
import { join } from 'node:path'
import type { OrchestratorSnapshot } from '@shared/orchestrator'
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
  constructor(private readonly directory?: string) {
    if (directory) mkdirSync(directory, { recursive: true })
  }

  private snapshotPath(key: string): string | undefined {
    return this.directory ? join(this.directory, `${sanitizeKey(key)}.json`) : undefined
  }

  private writeFileAtomic(path: string, data: string): void {
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, data, { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, path)
  }

  private readJson<T>(path: string): T | undefined {
    try {
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
    if (path) rmSync(path, { force: true })
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
  }

  /**
   * Read whether the previous process shut down cleanly, then arm the crash
   * marker for this run. A first launch (no index yet) counts as clean.
   */
  consumeCleanShutdownFlag(): boolean {
    const index = this.readIndex()
    const wasClean = index.cleanShutdown !== false
    this.writeIndex({ ...index, cleanShutdown: false })
    return wasClean
  }

  /** Called at the end of a successful shutdown flush. */
  markCleanShutdown(): void {
    this.writeIndex({ ...this.readIndex(), cleanShutdown: true })
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
