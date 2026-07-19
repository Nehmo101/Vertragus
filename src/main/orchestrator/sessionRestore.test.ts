import { describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({
  consumeCleanShutdownFlag: vi.fn(() => false),
  markCleanShutdown: vi.fn()
}))
const registry = vi.hoisted(() => ({
  rehydrate: vi.fn(() => 2),
  flushSnapshots: vi.fn()
}))
const migrate = vi.hoisted(() => vi.fn(() => 0))
const agents = vi.hoisted(() => ({
  startResumeStateSweep: vi.fn(),
  persistResumeStates: vi.fn()
}))

vi.mock('@main/config/store', () => ({ getProfile: vi.fn() }))
vi.mock('@main/config/sessionStore', () => ({
  sessionStore: store,
  migrateLegacySettingsSnapshots: migrate
}))
vi.mock('@main/orchestrator/WorkspaceSessionRegistry', () => ({
  workspaceSessions: registry
}))
vi.mock('@main/agents/AgentManager', () => ({ agentManager: agents }))

import {
  finalizeSessionPersistence,
  lastShutdownWasClean,
  prepareSessionPersistence
} from './sessionRestore'

describe('sessionRestore', () => {
  it('migrates, arms the crash marker and rehydrates on startup', () => {
    const result = prepareSessionPersistence()

    expect(migrate).toHaveBeenCalledOnce()
    expect(store.consumeCleanShutdownFlag).toHaveBeenCalledOnce()
    expect(registry.rehydrate).toHaveBeenCalledOnce()
    // Migration must run before the rehydrate pass reads the index.
    expect(migrate.mock.invocationCallOrder[0]!).toBeLessThan(
      registry.rehydrate.mock.invocationCallOrder[0]!
    )
    expect(result).toEqual({ cleanShutdown: false, restoredSessions: 2 })
    expect(lastShutdownWasClean()).toBe(false)
    expect(agents.startResumeStateSweep).toHaveBeenCalledOnce()
  })

  it('persists agent states and flushes every engine before marking the shutdown clean', () => {
    finalizeSessionPersistence()

    expect(agents.persistResumeStates).toHaveBeenCalledOnce()
    expect(registry.flushSnapshots).toHaveBeenCalledOnce()
    expect(store.markCleanShutdown).toHaveBeenCalledOnce()
    expect(agents.persistResumeStates.mock.invocationCallOrder[0]!).toBeLessThan(
      store.markCleanShutdown.mock.invocationCallOrder[0]!
    )
    expect(registry.flushSnapshots.mock.invocationCallOrder[0]!).toBeLessThan(
      store.markCleanShutdown.mock.invocationCallOrder[0]!
    )
  })
})
