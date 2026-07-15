import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_PROFILE } from '@shared/profile'

vi.mock('@main/orchestrator/Engine', () => ({
  OrchestratorEngine: class extends EventEmitter {
    readonly profileId: string
    readonly workspaceSessionId: string

    constructor(options: { profile: { id: string }; workspaceSessionId: string }) {
      super()
      this.profileId = options.profile.id
      this.workspaceSessionId = options.workspaceSessionId
    }

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
  }
}))

import { WorkspaceSessionRegistry } from './WorkspaceSessionRegistry'

describe('WorkspaceSessionRegistry', () => {
  it('keeps multiple independent runs for one profile and switches the active run', () => {
    const registry = new WorkspaceSessionRegistry()

    expect(registry.snapshot(DEFAULT_PROFILE)).toEqual({
      profileId: DEFAULT_PROFILE.id,
      goal: null,
      tasks: []
    })

    const first = registry.start(DEFAULT_PROFILE)
    const second = registry.start(DEFAULT_PROFILE)

    expect(first.id).not.toBe(second.id)
    expect(first.name).toBe('Minas Tirith')
    expect(second.name).toBe('Minas Morgul')
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
        name: 'Minas Morgul',
        active: true
      })
    ])
  })

  it('derives a name when reading a legacy session without a persisted name', () => {
    const registry = new WorkspaceSessionRegistry()
    const legacySession = registry.start(DEFAULT_PROFILE)
    delete (legacySession as { name?: string }).name

    expect(registry.list(DEFAULT_PROFILE.id)).toEqual([
      expect.objectContaining({
        id: legacySession.id,
        sequence: 1,
        name: 'Minas Tirith'
      })
    ])
  })
})
