import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_PROFILE } from '@shared/profile'
import { WORKSPACE_PLACE_NAMES } from '@shared/workspaceNames'
import type { OrchestratorSnapshot } from '@shared/orchestrator'
import type { SessionIndexEntry, SessionPersistence } from '@main/config/sessionStore'

// The registry pulls the sessionStore singleton (and through it electron and
// config/store); keep all of them inert so no test touches electron-store.
vi.mock('electron', () => ({
  app: { getPath: () => '.', getName: () => 'test', isPackaged: false }
}))
vi.mock('@main/config/store', () => ({}))

vi.mock('@main/orchestrator/Engine', () => ({
  OrchestratorEngine: class extends EventEmitter {
    readonly profileId: string
    readonly workspaceSessionId: string

    constructor(options: { profile: { id: string }; workspaceSessionId: string }) {
      super()
      this.profileId = options.profile.id
      this.workspaceSessionId = options.workspaceSessionId
    }

    flushSnapshot(): void {}

    snapshot(): {
      profileId: string
      workspaceSessionId: string
      goal: null
      tasks: []
    } {
      return {
        profileId: this.profileId,
        workspaceSessionId: this.workspaceSessionId,
        goal: null,
        tasks: []
      }
    }

    reset(): void {}
    dispose(): void {
      this.emit('disposed')
    }
    reviewPlan(): boolean {
      return true
    }
    setPlannerMode(): boolean {
      return true
    }
    enableAutoMode(): boolean {
      return true
    }
    setYolo(): boolean {
      return true
    }
  }
}))

import { WorkspaceSessionRegistry } from './WorkspaceSessionRegistry'

class FakeSessionStore implements SessionPersistence {
  readonly entries = new Map<string, SessionIndexEntry>()
  readonly snapshots = new Map<string, OrchestratorSnapshot>()

  upsertSession(entry: SessionIndexEntry): void {
    this.entries.set(entry.id, { ...entry })
  }

  touchSession(): void {}

  removeSession(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    this.entries.delete(id)
    this.snapshots.delete(entry.snapshotKey)
  }

  listSessions(): SessionIndexEntry[] {
    return [...this.entries.values()].sort((a, b) => a.startedAt - b.startedAt)
  }

  readSnapshot(key: string): OrchestratorSnapshot | undefined {
    return this.snapshots.get(key)
  }

  writeSnapshot(key: string, snapshot: OrchestratorSnapshot): void {
    this.snapshots.set(key, snapshot)
  }
}

function indexEntry(id: string, overrides: Partial<SessionIndexEntry> = {}): SessionIndexEntry {
  return {
    id,
    profileId: DEFAULT_PROFILE.id,
    name: `Session ${id}`,
    sequence: 1,
    snapshotKey: `orchestratorSnapshot:${DEFAULT_PROFILE.id}:${id}`,
    startedAt: 100,
    updatedAt: 100,
    ...overrides
  }
}

function progressSnapshot(): OrchestratorSnapshot {
  return {
    profileId: DEFAULT_PROFILE.id,
    goal: { id: 'goal-1', title: 'Weiterarbeiten', active: false },
    tasks: []
  } as unknown as OrchestratorSnapshot
}

describe('WorkspaceSessionRegistry', () => {
  it('keeps multiple independent runs for one profile and switches the active run', () => {
    const registry = new WorkspaceSessionRegistry(() => 0)

    expect(registry.snapshot(DEFAULT_PROFILE)).toEqual({
      profileId: DEFAULT_PROFILE.id,
      goal: null,
      tasks: []
    })

    const first = registry.start(DEFAULT_PROFILE)
    const second = registry.start(DEFAULT_PROFILE)

    expect(first.id).not.toBe(second.id)
    expect(first.name).toBe('Purgatorio')
    expect(second.name).toBe('Inferno')
    expect(registry.list(DEFAULT_PROFILE.id)).toHaveLength(2)
    expect(registry.list(DEFAULT_PROFILE.id).find((session) => session.active)?.id).toBe(second.id)

    registry.setActive(DEFAULT_PROFILE.id, first.id)
    expect(registry.getByProfile(DEFAULT_PROFILE.id)?.id).toBe(first.id)
    expect(registry.list(DEFAULT_PROFILE.id).find((session) => session.active)?.id).toBe(first.id)

    expect(registry.enableAutoMode(DEFAULT_PROFILE, first.id)).toBe(true)
    expect(first.profile.planner.mode).toBe('auto')
    expect(second.profile.planner.mode).toBe('review')
    expect(DEFAULT_PROFILE.planner.mode).toBe('review')

    const disposed = vi.fn()
    first.engine.once('disposed', disposed)
    registry.removeSession(first.id)
    expect(disposed).toHaveBeenCalledOnce()
    expect(registry.getByProfile(DEFAULT_PROFILE.id)?.id).toBe(second.id)
    expect(registry.list(DEFAULT_PROFILE.id)).toEqual([
      expect.objectContaining({
        id: second.id,
        sequence: 2,
        name: second.name,
        active: true
      })
    ])
  })

  it('propagates the yolo master to every live session without touching the source profile', () => {
    const registry = new WorkspaceSessionRegistry(() => 0)
    const first = registry.start(DEFAULT_PROFILE)
    const second = registry.start(DEFAULT_PROFILE)

    expect(registry.setYoloMaster(true)).toBe(2)
    expect(first.profile.yoloDefault).toBe(true)
    expect(second.profile.yoloDefault).toBe(true)
    expect(DEFAULT_PROFILE.yoloDefault).toBe(false)

    expect(registry.setYoloMaster(false)).toBe(2)
    expect(first.profile.yoloDefault).toBe(false)
  })

  it('assigns one unique random place per profile cycle before adding a suffix', () => {
    const registry = new WorkspaceSessionRegistry(() => 0)
    const firstCycleNames = Array.from(
      { length: WORKSPACE_PLACE_NAMES.length },
      () => registry.start(DEFAULT_PROFILE).name
    )

    expect(firstCycleNames[0]).not.toBe('Paradiso')
    expect(new Set(firstCycleNames).size).toBe(WORKSPACE_PLACE_NAMES.length)
    expect(registry.start(DEFAULT_PROFILE).name).toBe(`${firstCycleNames[0]} II`)
  })

  it('does not reuse an assigned place when an earlier session is removed', () => {
    const registry = new WorkspaceSessionRegistry(() => 0)
    const first = registry.start(DEFAULT_PROFILE)
    const second = registry.start(DEFAULT_PROFILE)

    registry.removeSession(first.id)
    const third = registry.start(DEFAULT_PROFILE)

    expect(new Set([first.name, second.name, third.name]).size).toBe(3)
  })

  it('derives a name when reading a legacy session without a persisted name', () => {
    const registry = new WorkspaceSessionRegistry(() => 0)
    const legacySession = registry.start(DEFAULT_PROFILE)
    delete (legacySession as { name?: string }).name

    expect(registry.list(DEFAULT_PROFILE.id)).toEqual([
      expect.objectContaining({
        id: legacySession.id,
        sequence: 1,
        name: 'Paradiso'
      })
    ])
  })

  it('registers created sessions in the persistent index and removes them again', () => {
    const store = new FakeSessionStore()
    const registry = new WorkspaceSessionRegistry(() => 0, store)

    const session = registry.start(DEFAULT_PROFILE)
    expect(store.entries.get(session.id)).toMatchObject({
      id: session.id,
      profileId: DEFAULT_PROFILE.id,
      name: session.name,
      sequence: 1,
      snapshotKey: `orchestratorSnapshot:${DEFAULT_PROFILE.id}:${session.id}`
    })

    registry.removeSession(session.id)
    expect(store.entries.size).toBe(0)
  })

  it('rehydrates persisted sessions with progress and drops empty or orphaned entries', () => {
    const store = new FakeSessionStore()
    const meaningful = indexEntry('session-a', { sequence: 3, startedAt: 100 })
    const empty = indexEntry('session-b', { startedAt: 200 })
    const orphaned = indexEntry('session-c', { profileId: 'deleted-profile', startedAt: 300 })
    store.entries.set(meaningful.id, meaningful)
    store.entries.set(empty.id, empty)
    store.entries.set(orphaned.id, orphaned)
    store.writeSnapshot(meaningful.snapshotKey, progressSnapshot())
    store.writeSnapshot(orphaned.snapshotKey, progressSnapshot())

    const registry = new WorkspaceSessionRegistry(() => 0, store)
    const changed = vi.fn()
    registry.on('changed', changed)

    expect(
      registry.rehydrate((profileId) => (profileId === DEFAULT_PROFILE.id ? DEFAULT_PROFILE : undefined))
    ).toBe(1)

    expect(changed).toHaveBeenCalledOnce()
    expect(registry.list(DEFAULT_PROFILE.id)).toEqual([
      expect.objectContaining({
        id: 'session-a',
        name: 'Session session-a',
        sequence: 3,
        active: true
      })
    ])
    // Empty and orphaned entries are cleaned out of the store.
    expect(store.entries.has('session-b')).toBe(false)
    expect(store.entries.has('session-c')).toBe(false)
    expect(store.snapshots.has(orphaned.snapshotKey)).toBe(false)

    // A fresh session after rehydration continues past the restored sequence.
    expect(registry.start(DEFAULT_PROFILE).sequence).toBe(4)
  })

  it('rehydrates at most once per session id', () => {
    const store = new FakeSessionStore()
    const entry = indexEntry('session-a')
    store.entries.set(entry.id, entry)
    store.writeSnapshot(entry.snapshotKey, progressSnapshot())

    const registry = new WorkspaceSessionRegistry(() => 0, store)
    expect(registry.rehydrate(() => DEFAULT_PROFILE)).toBe(1)
    expect(registry.rehydrate(() => DEFAULT_PROFILE)).toBe(0)
    expect(registry.list(DEFAULT_PROFILE.id)).toHaveLength(1)
  })

  it('updates the session task summary when the orchestrator snapshot changes', () => {
    const registry = new WorkspaceSessionRegistry()
    const session = registry.start(DEFAULT_PROFILE)
    const changed = vi.fn()
    registry.on('changed', changed)

    session.engine.emit('snapshot', {
      profileId: DEFAULT_PROFILE.id,
      workspaceSessionId: session.id,
      goal: { id: 'goal-1', title: 'Workspace-Summary integrieren', active: true },
      activity: {
        phase: 'monitoring',
        summary: 'Verdrahtet den Datenfluss.',
        details: [],
        updatedAt: 1
      },
      tasks: []
    })
    expect(registry.list(DEFAULT_PROFILE.id)[0]?.taskSummary)
      .toBe('Workspace-Summary integrieren')
    expect(changed).toHaveBeenLastCalledWith([
      expect.objectContaining({
        id: session.id,
        taskSummary: 'Workspace-Summary integrieren'
      })
    ])

    session.engine.emit('snapshot', {
      profileId: DEFAULT_PROFILE.id,
      workspaceSessionId: session.id,
      goal: null,
      tasks: []
    })
    expect(registry.list(DEFAULT_PROFILE.id)[0]?.taskSummary).toBeUndefined()
    expect(changed).toHaveBeenCalledTimes(2)
    expect(changed).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: session.id, taskSummary: undefined })
    ])
  })
})
