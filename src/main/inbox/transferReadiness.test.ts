import { describe, expect, it } from 'vitest'
import { DEFAULT_PROFILE } from '@shared/profile'
import { assessProfileOrchestrator, assessRepoReadiness, buildNeedsAuthReadiness, mapGithubErrorToTransferAction } from '@main/inbox/transferReadiness'

describe('transfer repo readiness', () => {
  it('requires orchestrator on profile', () => {
    const noOrch = { ...DEFAULT_PROFILE, orchestrator: undefined }
    expect(assessProfileOrchestrator(noOrch).ok).toBe(false)
    expect(assessProfileOrchestrator(DEFAULT_PROFILE).ok).toBe(true)
  })

  it('blocks manual planner mode', () => {
    const manual = {
      ...DEFAULT_PROFILE,
      planner: { ...DEFAULT_PROFILE.planner, mode: 'manual' as const }
    }
    expect(assessProfileOrchestrator(manual).ok).toBe(false)
  })

  it('flags missing repo binding', () => {
    const profile = { ...DEFAULT_PROFILE, workingDir: '', githubRepo: undefined }
    const result = assessRepoReadiness(profile)
    expect(result.ready).toBe(false)
    if (!result.ready) {
      expect(result.action).toBe('needsRepo')
      expect(result.retryable).toBe(true)
    }
  })

  it('flags unbound github repo needing clone', () => {
    const profile = {
      ...DEFAULT_PROFILE,
      workingDir: 'C:\\git\\demo',
      githubRepo: {
        owner: 'acme',
        repo: 'shop',
        defaultBranch: 'main',
        localPath: 'C:\\git\\demo',
        cloneStatus: 'linked' as const
      }
    }
    const result = assessRepoReadiness(profile, 'linked')
    expect(result.ready).toBe(false)
    if (!result.ready) {
      expect(result.action).toBe('needsClone')
      expect(result.owner).toBe('acme')
      expect(result.repo).toBe('shop')
    }
  })

  it('accepts cloned github binding', () => {
    const profile = {
      ...DEFAULT_PROFILE,
      workingDir: 'C:\\git\\demo',
      githubRepo: {
        owner: 'acme',
        repo: 'shop',
        defaultBranch: 'main',
        localPath: 'C:\\git\\demo',
        cloneStatus: 'cloned' as const
      }
    }
    const result = assessRepoReadiness(profile, 'cloned')
    expect(result.ready).toBe(true)
    if (result.ready) expect(result.localPath).toBe('C:\\git\\demo')
  })

  it('accepts plain workingDir without githubRepo', () => {
    const profile = { ...DEFAULT_PROFILE, workingDir: 'C:\\git\\local' }
    const result = assessRepoReadiness(profile)
    expect(result.ready).toBe(true)
    if (result.ready) expect(result.localPath).toBe('C:\\git\\local')
  })

  it('maps github auth errors to needsAuth action', () => {
    expect(mapGithubErrorToTransferAction(new Error('GitHub-Anmeldung fehlt'))).toBe('needsAuth')
    expect(mapGithubErrorToTransferAction(new Error('HTTP 401 Unauthorized'))).toBe('needsAuth')
    expect(mapGithubErrorToTransferAction(new Error('disk full'))).toBeUndefined()
    const blocked = buildNeedsAuthReadiness()
    expect(blocked.action).toBe('needsAuth')
    expect(blocked.retryable).toBe(true)
  })
})
