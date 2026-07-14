import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_PROFILE, type WorkspaceProfile } from '@shared/profile'
import {
  deleteWorkspaceProfile,
  type WorkspaceProfileDeletionDependencies
} from './deleteWorkspaceProfile'

const PROFILE: WorkspaceProfile = { ...DEFAULT_PROFILE, id: 'custom', name: 'Custom' }

function dependencies(
  overrides: Partial<WorkspaceProfileDeletionDependencies> = {}
): WorkspaceProfileDeletionDependencies {
  return {
    getProfile: vi.fn(() => PROFILE),
    hasRunningAgents: vi.fn(() => false),
    deletePersistedProfile: vi.fn(() => [DEFAULT_PROFILE]),
    removeWorkspaceSessions: vi.fn(),
    ...overrides
  }
}

describe('deleteWorkspaceProfile', () => {
  it('deletes a known idle profile before removing its workspace sessions', () => {
    const order: string[] = []
    const deps = dependencies({
      deletePersistedProfile: vi.fn(() => {
        order.push('persist')
        return [DEFAULT_PROFILE]
      }),
      removeWorkspaceSessions: vi.fn(() => {
        order.push('sessions')
      })
    })

    expect(deleteWorkspaceProfile(PROFILE.id, deps)).toEqual([DEFAULT_PROFILE])
    expect(deps.hasRunningAgents).toHaveBeenCalledWith(PROFILE.id)
    expect(order).toEqual(['persist', 'sessions'])
  })

  it('rejects an unknown profile id without mutating state', () => {
    const deps = dependencies({ getProfile: vi.fn(() => undefined) })

    expect(() => deleteWorkspaceProfile('../missing', deps)).toThrow(
      'Workspace-Profil nicht gefunden.'
    )
    expect(deps.hasRunningAgents).not.toHaveBeenCalled()
    expect(deps.deletePersistedProfile).not.toHaveBeenCalled()
    expect(deps.removeWorkspaceSessions).not.toHaveBeenCalled()
  })

  it('keeps the existing main-process guard for a running target profile', () => {
    const deps = dependencies({ hasRunningAgents: vi.fn(() => true) })

    expect(() => deleteWorkspaceProfile(PROFILE.id, deps)).toThrow(/laufenden Agent-Session/)
    expect(deps.deletePersistedProfile).not.toHaveBeenCalled()
    expect(deps.removeWorkspaceSessions).not.toHaveBeenCalled()
  })

  it('does not invent a protection rule for the default profile', () => {
    const deps = dependencies({
      getProfile: vi.fn(() => DEFAULT_PROFILE),
      deletePersistedProfile: vi.fn(() => [DEFAULT_PROFILE])
    })

    expect(deleteWorkspaceProfile(DEFAULT_PROFILE.id, deps)).toEqual([DEFAULT_PROFILE])
    expect(deps.deletePersistedProfile).toHaveBeenCalledWith(DEFAULT_PROFILE.id)
    expect(deps.removeWorkspaceSessions).toHaveBeenCalledWith(DEFAULT_PROFILE.id)
  })

  it('preserves workspace sessions when persistence fails', () => {
    const deps = dependencies({
      deletePersistedProfile: vi.fn(() => {
        throw new Error('disk full')
      })
    })

    expect(() => deleteWorkspaceProfile(PROFILE.id, deps)).toThrow('disk full')
    expect(deps.removeWorkspaceSessions).not.toHaveBeenCalled()
  })
})
