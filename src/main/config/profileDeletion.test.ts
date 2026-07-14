import { describe, expect, it } from 'vitest'
import { DEFAULT_PROFILE, type WorkspaceProfile } from '@shared/profile'
import { deriveProfileDeletion } from './profileDeletion'

function profile(id: string): WorkspaceProfile {
  return { ...DEFAULT_PROFILE, id, name: id }
}

describe('deriveProfileDeletion', () => {
  it('removes an idle profile while retaining a different active profile', () => {
    const active = profile('active')
    const removed = profile('removed')

    expect(deriveProfileDeletion([active, removed], active.id, removed.id)).toEqual({
      profiles: [active],
      activeProfileId: active.id
    })
  })

  it('selects the first remaining profile when the active profile is deleted', () => {
    const removed = profile('removed')
    const replacement = profile('replacement')

    expect(deriveProfileDeletion([removed, replacement], removed.id, removed.id)).toEqual({
      profiles: [replacement],
      activeProfileId: replacement.id
    })
  })

  it('restores the default profile when the last profile is deleted', () => {
    const last = profile('last')

    expect(deriveProfileDeletion([last], last.id, last.id)).toEqual({
      profiles: [DEFAULT_PROFILE],
      activeProfileId: DEFAULT_PROFILE.id
    })
  })

  it('does not treat the default profile as protected when another profile remains', () => {
    const replacement = profile('replacement')

    expect(
      deriveProfileDeletion([DEFAULT_PROFILE, replacement], DEFAULT_PROFILE.id, DEFAULT_PROFILE.id)
    ).toEqual({
      profiles: [replacement],
      activeProfileId: replacement.id
    })
  })

  it('rejects an unknown profile id without deriving a mutation', () => {
    expect(() => deriveProfileDeletion([DEFAULT_PROFILE], DEFAULT_PROFILE.id, '../missing')).toThrow(
      'Workspace-Profil nicht gefunden.'
    )
  })
})
