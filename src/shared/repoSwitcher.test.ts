import { describe, expect, it } from 'vitest'
import type { WorkspaceProfile } from './profile'
import { DEFAULT_PROFILE } from './profile'
import {
  collectKnownRepos,
  parseActiveRepo,
  parseRecentRepos,
  profileRepoRef,
  repoRefKey,
  repoRefLabel,
  resolveActiveRepoPath,
  type RepoRef
} from './repoSwitcher'

function profile(overrides: Partial<WorkspaceProfile>): WorkspaceProfile {
  return { ...DEFAULT_PROFILE, ...overrides }
}

describe('repoRefKey', () => {
  it('normalizes separators and trailing slashes', () => {
    expect(repoRefKey('C:\\git\\Repo\\')).toBe('c:/git/repo')
    expect(repoRefKey('/home/user/repo/')).toBe('/home/user/repo')
  })

  it('is case-insensitive only for Windows drive paths', () => {
    expect(repoRefKey('C:/Git/Repo')).toBe(repoRefKey('c:/git/repo'))
    expect(repoRefKey('/Home/Repo')).not.toBe(repoRefKey('/home/repo'))
  })
})

describe('repoRefLabel', () => {
  it('prefers an explicit label', () => {
    expect(repoRefLabel({ path: '/x/y', label: 'My Repo' })).toBe('My Repo')
  })

  it('falls back to owner/repo then folder name', () => {
    expect(repoRefLabel({ path: '/x/y', owner: 'acme', repo: 'thing' })).toBe('acme/thing')
    expect(repoRefLabel({ path: 'C:\\git\\Orca-Strator' })).toBe('Orca-Strator')
  })
})

describe('profileRepoRef', () => {
  it('returns null for an unbound profile', () => {
    expect(profileRepoRef(profile({ workingDir: '' }))).toBeNull()
  })

  it('uses the github binding local path and owner/repo', () => {
    const ref = profileRepoRef(
      profile({
        name: 'Board',
        workingDir: '/fallback',
        githubRepo: {
          owner: 'acme',
          repo: 'thing',
          defaultBranch: 'main',
          localPath: '/clone/thing',
          cloneStatus: 'linked'
        }
      })
    )
    expect(ref).toEqual({ path: '/clone/thing', label: undefined, owner: 'acme', repo: 'thing' })
  })

  it('labels a plain working-dir binding with the profile name', () => {
    const ref = profileRepoRef(profile({ name: 'Local', workingDir: '/w/app' }))
    expect(ref).toEqual({ path: '/w/app', label: 'Local', owner: undefined, repo: undefined })
  })
})

describe('collectKnownRepos', () => {
  it('lists profile repos first, then recents, de-duplicated by path', () => {
    const profiles = [
      profile({ id: 'a', name: 'A', workingDir: '/repo/a' }),
      profile({ id: 'b', name: 'B', workingDir: '/repo/b' })
    ]
    const recents: RepoRef[] = [
      { path: '/repo/b' }, // duplicate of profile B — dropped
      { path: '/repo/c', label: 'C' }
    ]
    const list = collectKnownRepos(profiles, recents, { path: '/repo/a' })
    expect(list.map((r) => r.path)).toEqual(['/repo/a', '/repo/b', '/repo/c'])
    // The profile-derived entry keeps its label, not the active override.
    expect(list[0].label).toBe('A')
  })

  it('appends the active repo when it is otherwise unknown', () => {
    const list = collectKnownRepos([], [], { path: '/repo/z', label: 'Z' })
    expect(list).toEqual([{ path: '/repo/z', label: 'Z' }])
  })
})

describe('resolveActiveRepoPath', () => {
  const bound = profile({ workingDir: '/profile/repo' })

  it('prefers an explicit override', () => {
    expect(resolveActiveRepoPath({ path: '/override' }, bound)).toBe('/override')
  })

  it('falls back to the active profile default', () => {
    expect(resolveActiveRepoPath(null, bound)).toBe('/profile/repo')
    expect(resolveActiveRepoPath({ path: '   ' }, bound)).toBe('/profile/repo')
  })

  it('returns empty string without any repository', () => {
    expect(resolveActiveRepoPath(null, undefined)).toBe('')
    expect(resolveActiveRepoPath(null, profile({ workingDir: '' }))).toBe('')
  })
})

describe('parseActiveRepo / parseRecentRepos', () => {
  it('parses a valid override and rejects junk', () => {
    expect(parseActiveRepo({ path: '/x' })).toEqual({ path: '/x' })
    expect(parseActiveRepo(null)).toBeNull()
    expect(parseActiveRepo('')).toBeNull()
    expect(parseActiveRepo({ path: '' })).toBeNull()
    expect(parseActiveRepo({ nope: true })).toBeNull()
  })

  it('parses recents, dropping invalid and duplicate entries', () => {
    const parsed = parseRecentRepos([
      { path: '/a' },
      { path: '/a' },
      { bad: 1 },
      { path: '/b', label: 'B' }
    ])
    expect(parsed).toEqual([{ path: '/a' }, { path: '/b', label: 'B' }])
    expect(parseRecentRepos('nope')).toEqual([])
  })
})
