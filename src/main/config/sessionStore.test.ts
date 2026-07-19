import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrchestratorSnapshot } from '@shared/orchestrator'

vi.mock('electron', () => ({
  app: { getPath: () => '.', getName: () => 'test', isPackaged: false }
}))

const settings = vi.hoisted(() => new Map<string, unknown>())
vi.mock('@main/config/store', () => ({
  getSetting: (key: string) => settings.get(key),
  setSetting: (key: string, value: unknown) => settings.set(key, value),
  listSettingKeys: (prefix: string) =>
    [...settings.keys()].filter((key) => key.startsWith(prefix)),
  deleteSetting: (key: string) => settings.delete(key)
}))

import {
  hasPersistedProgress,
  migrateLegacySettingsSnapshots,
  orchestratorSnapshotKey,
  SessionStore,
  type SessionIndexEntry
} from './sessionStore'

const dirs: string[] = []

function tempStore(): SessionStore {
  const dir = mkdtempSync(join(tmpdir(), 'vertragus-sessions-'))
  dirs.push(dir)
  return new SessionStore(dir)
}

function snapshot(overrides: Partial<OrchestratorSnapshot> = {}): OrchestratorSnapshot {
  return {
    profileId: 'default',
    goal: { id: 'goal-1', title: 'Ziel', active: true },
    tasks: [],
    ...overrides
  } as OrchestratorSnapshot
}

function entry(overrides: Partial<SessionIndexEntry> = {}): SessionIndexEntry {
  return {
    id: 'session-1',
    profileId: 'default',
    name: 'Purgatorio',
    sequence: 1,
    snapshotKey: orchestratorSnapshotKey('default', 'session-1'),
    startedAt: 100,
    updatedAt: 100,
    ...overrides
  }
}

afterEach(() => {
  settings.clear()
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe('SessionStore', () => {
  it('round-trips snapshots without leaving temp files behind', () => {
    const store = tempStore()
    const key = orchestratorSnapshotKey('default', 'session-1')
    store.writeSnapshot(key, snapshot())
    store.writeSnapshot(key, snapshot({ goal: { id: 'goal-2', title: 'Neu', active: false } }))

    expect(store.readSnapshot(key)?.goal?.id).toBe('goal-2')
    expect(readdirSync(dirs[0]!).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('refuses a file whose embedded key does not match (sanitize collision)', () => {
    const store = tempStore()
    // 'a:b' and 'a_b' sanitize to the same file name.
    store.writeSnapshot('orchestratorSnapshot:a_b', snapshot())
    expect(store.readSnapshot('orchestratorSnapshot:a:b')).toBeUndefined()
    expect(store.readSnapshot('orchestratorSnapshot:a_b')).toBeDefined()
  })

  it('indexes sessions sorted by startedAt and removes their snapshots with the entry', () => {
    const store = tempStore()
    const second = entry({ id: 'session-2', startedAt: 200, snapshotKey: orchestratorSnapshotKey('default', 'session-2') })
    store.upsertSession(second)
    store.upsertSession(entry())
    store.writeSnapshot(second.snapshotKey, snapshot())

    expect(store.listSessions().map((session) => session.id)).toEqual(['session-1', 'session-2'])

    store.removeSession('session-2')
    expect(store.listSessions().map((session) => session.id)).toEqual(['session-1'])
    expect(store.readSnapshot(second.snapshotKey)).toBeUndefined()
  })

  it('stores agent resume states per session and removes them with the session', () => {
    const store = tempStore()
    const state = {
      info: { id: 'codex-01' },
      scrollbackTail: 'letzter Stand',
      capturedAt: 1
    } as never
    store.upsertSession(entry())
    store.writeAgentResumeStates('session-1', [state])

    expect(store.readAgentResumeStates('session-1')).toEqual([
      expect.objectContaining({ scrollbackTail: 'letzter Stand' })
    ])
    expect(store.readAgentResumeStates('andere-session')).toEqual([])

    store.removeSession('session-1')
    expect(store.readAgentResumeStates('session-1')).toEqual([])
  })

  it('tracks the clean-shutdown marker across consume/mark cycles', () => {
    const store = tempStore()
    // First launch: no index yet counts as clean, and arms the crash marker.
    expect(store.consumeCleanShutdownFlag()).toBe(true)
    // Simulated crash: next consume sees the armed marker.
    expect(store.consumeCleanShutdownFlag()).toBe(false)
    store.markCleanShutdown()
    expect(store.consumeCleanShutdownFlag()).toBe(true)
  })

  it('is inert without a directory', () => {
    const store = new SessionStore(undefined)
    store.writeSnapshot('orchestratorSnapshot:x', snapshot())
    store.upsertSession(entry())

    expect(store.readSnapshot('orchestratorSnapshot:x')).toBeUndefined()
    expect(store.listSessions()).toEqual([])
    expect(store.consumeCleanShutdownFlag()).toBe(true)
  })

  it('treats only goals or task history as restorable progress', () => {
    expect(hasPersistedProgress(undefined)).toBe(false)
    expect(hasPersistedProgress(snapshot({ goal: null, tasks: [] }))).toBe(false)
    expect(hasPersistedProgress(snapshot({ goal: null, tasks: [{ id: 't-1' } as never] }))).toBe(true)
    expect(hasPersistedProgress(snapshot())).toBe(true)
  })
})

describe('migrateLegacySettingsSnapshots', () => {
  it('moves settings-bag snapshots into files and indexes fully qualified sessions', () => {
    const store = tempStore()
    const qualified = orchestratorSnapshotKey('default', 'session-legacy')
    settings.set(qualified, snapshot())
    settings.set(orchestratorSnapshotKey('default'), snapshot())
    settings.set('orchestratorSnapshot', 'kaputt')
    settings.set('unrelated', 42)

    expect(migrateLegacySettingsSnapshots(store)).toBe(2)

    expect(store.readSnapshot(qualified)?.goal?.id).toBe('goal-1')
    expect(store.readSnapshot(orchestratorSnapshotKey('default'))).toBeDefined()
    expect(store.listSessions()).toEqual([
      expect.objectContaining({ id: 'session-legacy', profileId: 'default', snapshotKey: qualified })
    ])
    // Every legacy key is gone afterwards — including unreadable ones.
    expect([...settings.keys()]).toEqual(['unrelated'])
  })

  it('does not index empty legacy sessions', () => {
    const store = tempStore()
    settings.set(
      orchestratorSnapshotKey('default', 'session-empty'),
      snapshot({ goal: null, tasks: [] })
    )

    expect(migrateLegacySettingsSnapshots(store)).toBe(1)
    expect(store.listSessions()).toEqual([])
  })
})
