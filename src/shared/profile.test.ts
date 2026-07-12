import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PROFILE,
  profileDefaultBaseBranch,
  profileRepoLocalPath,
  workspaceProfileSchema
} from './profile'

describe('workspaceProfileSchema', () => {
  it('migrates legacy profiles with planner and Auto-PR defaults', () => {
    const profile = workspaceProfileSchema.parse({
      id: 'legacy',
      name: 'Legacy',
      workingDir: '',
      orchestrator: { provider: 'codex', model: '', autoOpenSubwindows: true },
      agents: [],
      yoloDefault: false
    })
    expect(profile.planner.mode).toBe('review')
    expect(profile.autoPr.mode).toBe('off')
    expect(profile.orchestrator?.model).toBe('')
  })

  it('keeps the default profile valid', () => {
    expect(workspaceProfileSchema.parse(DEFAULT_PROFILE)).toEqual(DEFAULT_PROFILE)
  })

  it('accepts optional githubRepo binding with defaults', () => {
    const profile = workspaceProfileSchema.parse({
      id: 'gh',
      name: 'GitHub bound',
      workingDir: 'C:\\git\\demo',
      githubRepo: { owner: 'acme', repo: 'demo' },
      agents: [],
      yoloDefault: false
    })
    expect(profile.githubRepo).toEqual({
      owner: 'acme',
      repo: 'demo',
      defaultBranch: '',
      localPath: '',
      cloneStatus: 'unbound'
    })
  })

  it('resolves profile local path and default base branch precedence', () => {
    const profile = workspaceProfileSchema.parse({
      id: 'x',
      name: 'x',
      workingDir: 'C:\\fallback',
      githubRepo: {
        owner: 'acme',
        repo: 'demo',
        defaultBranch: 'develop',
        localPath: 'C:\\git\\demo',
        cloneStatus: 'cloned'
      },
      autoPr: { baseBranch: '' },
      agents: [],
      yoloDefault: false
    })
    expect(profileRepoLocalPath(profile)).toBe('C:\\git\\demo')
    expect(profileDefaultBaseBranch(profile)).toBe('develop')
    expect(
      profileDefaultBaseBranch({
        ...profile,
        autoPr: { ...profile.autoPr, baseBranch: 'release' }
      })
    ).toBe('release')
  })
})
