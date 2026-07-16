import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  agentSlotsWithRoles,
  DEFAULT_PROFILE,
  duplicateProfile,
  profileDefaultBaseBranch,
  profileRepoLocalPath,
  type WorkspaceProfile,
  workspaceProfileSchema
} from './profile'

function completeProfile(): WorkspaceProfile {
  return workspaceProfileSchema.parse({
    id: 'source-profile',
    name: 'Projekt',
    workingDir: 'C:\\git\\projekt',
    githubRepo: {
      owner: 'acme',
      repo: 'projekt',
      defaultBranch: 'develop',
      localPath: 'C:\\git\\projekt',
      cloneStatus: 'linked'
    },
    githubProject: {
      owner: 'acme',
      number: 42,
      title: 'Projektplanung',
      url: 'https://github.com/orgs/acme/projects/42'
    },
    orchestrator: {
      provider: 'claude',
      model: 'claude-opus',
      modelPreset: 'strong',
      autoOpenSubwindows: false
    },
    agents: [
      {
        role: 'worker',
        provider: 'codex',
        model: 'gpt-codex',
        modelPreset: 'balanced',
        count: 2,
        orchestrated: true,
        yolo: true,
        workingDir: 'C:\\git\\projekt\\worker',
        strengths: ['Tests', 'Debugging'],
        weaknesses: ['Grafikdesign']
      },
      {
        role: 'reviewer',
        provider: 'cursor',
        model: 'composer',
        count: 1,
        orchestrated: false,
        yolo: false,
        strengths: ['Review'],
        weaknesses: []
      }
    ],
    yoloDefault: true,
    planner: { mode: 'manual', routingMode: 'fixed', maxParallel: 3, maxRetries: 2 },
    benchmark: { enabled: true },
    autoPr: {
      mode: 'hold-for-approval',
      strategy: 'per-task',
      baseBranch: 'develop',
      qualityGates: ['corepack pnpm test', 'corepack pnpm lint'],
      securityGateExcludes: ['fixtures/**'],
      labels: ['automation', 'review'],
      reviewers: ['octocat']
    }
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

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

  it('accepts the review-gated Auto-PR publication mode', () => {
    const profile = workspaceProfileSchema.parse({
      ...DEFAULT_PROFILE,
      autoPr: { ...DEFAULT_PROFILE.autoPr, mode: 'hold-for-approval' }
    })
    expect(profile.autoPr.mode).toBe('hold-for-approval')
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

  it('assigns the same stable unique role keys used by team start and dispatch', () => {
    const slots = [
      {
        role: 'Worker', provider: 'codex' as const, model: '', count: 2, orchestrated: true,
        yolo: false, strengths: [], weaknesses: []
      },
      {
        role: 'Worker', provider: 'cursor' as const, model: 'composer', count: 1, orchestrated: true,
        yolo: false, strengths: [], weaknesses: []
      },
      {
        role: 'Review', provider: 'claude' as const, model: 'sonnet', count: 1, orchestrated: true,
        yolo: false, strengths: [], weaknesses: []
      }
    ]

    expect(agentSlotsWithRoles(slots).map(({ role }) => role)).toEqual([
      'worker',
      'worker-2',
      'review'
    ])
    expect(
      agentSlotsWithRoles([
        { ...slots[0], orchestrated: false },
        slots[1]
      ])
        .filter(({ slot }) => slot.orchestrated)
        .map(({ role }) => role)
    ).toEqual(['worker-2'])
  })
})

describe('duplicateProfile', () => {
  it('copies every configurable setting except the intentional safety resets', () => {
    const source = completeProfile()
    const copy = duplicateProfile(source, [source])
    const { id: copyId, name: copyName, ...copySettings } = copy
    const { id: sourceId, name: sourceName, ...sourceSettings } = source

    expect(copySettings).toEqual({
      ...sourceSettings,
      githubRepo: { ...source.githubRepo, cloneStatus: 'unbound', localPath: '' },
      githubProject: { ...source.githubProject },
      agents: source.agents.map((slot) => ({ ...slot, yolo: false })),
      yoloDefault: false
    })
    expect(copyId).not.toBe(sourceId)
    expect(copyName).not.toBe(sourceName)
  })

  it('creates a new id and appends a suffix when the timestamp id already exists', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_234_567_890)
    const source = completeProfile()
    const baseId = `profile-${Date.now().toString(36)}`
    const existingProfiles = [
      source,
      { ...source, id: baseId, name: 'Anderes Profil' },
      { ...source, id: `${baseId}-2`, name: 'Noch ein Profil' }
    ]

    expect(duplicateProfile(source, existingProfiles).id).toBe(`${baseId}-3`)
  })

  it('derives a unique copy name using trimmed, case-insensitive comparison', () => {
    const source = completeProfile()
    const existingProfiles = [
      source,
      { ...source, id: 'existing-copy', name: '  PROJEKT (kopie)  ' }
    ]

    expect(duplicateProfile(source, existingProfiles).name).toBe('Projekt (Kopie 2)')
  })

  it('clears the local repository binding while preserving remote metadata', () => {
    const source = completeProfile()
    const copy = duplicateProfile(source, [source])

    expect(copy.githubRepo).toEqual({
      owner: source.githubRepo!.owner,
      repo: source.githubRepo!.repo,
      defaultBranch: source.githubRepo!.defaultBranch,
      cloneStatus: 'unbound',
      localPath: ''
    })
  })

  it('resets the profile default and every agent slot from yolo to safe mode', () => {
    const source = completeProfile()
    source.agents = source.agents.map((slot) => ({ ...slot, yolo: true }))

    const copy = duplicateProfile(source, [source])

    expect(source.yoloDefault).toBe(true)
    expect(source.agents.every((slot) => slot.yolo)).toBe(true)
    expect(copy.yoloDefault).toBe(false)
    expect(copy.agents.every((slot) => !slot.yolo)).toBe(true)
  })

  it('deep-clones the GitHub project configuration', () => {
    const source = completeProfile()
    const copy = duplicateProfile(source, [source])

    expect(copy.githubProject).not.toBe(source.githubProject)
    copy.githubProject!.title = 'Changed'

    expect(source.githubProject!.title).toBe('Projektplanung')
  })

  it('leaves the original deeply unchanged and shares no nested references', () => {
    const source = completeProfile()
    const original = structuredClone(source)
    const copy = duplicateProfile(source, [source])

    expect(copy.githubRepo).not.toBe(source.githubRepo)
    expect(copy.githubProject).not.toBe(source.githubProject)
    expect(copy.orchestrator).not.toBe(source.orchestrator)
    expect(copy.agents).not.toBe(source.agents)
    expect(copy.agents[0]).not.toBe(source.agents[0])
    expect(copy.agents[0].strengths).not.toBe(source.agents[0].strengths)
    expect(copy.agents[0].weaknesses).not.toBe(source.agents[0].weaknesses)
    expect(copy.planner).not.toBe(source.planner)
    expect(copy.benchmark).not.toBe(source.benchmark)
    expect(copy.autoPr).not.toBe(source.autoPr)
    expect(copy.autoPr.qualityGates).not.toBe(source.autoPr.qualityGates)
    expect(copy.autoPr.securityGateExcludes).not.toBe(source.autoPr.securityGateExcludes)
    expect(copy.autoPr.labels).not.toBe(source.autoPr.labels)
    expect(copy.autoPr.reviewers).not.toBe(source.autoPr.reviewers)

    copy.githubRepo!.owner = 'changed'
    copy.githubProject!.title = 'Changed'
    copy.orchestrator!.model = 'changed'
    copy.agents[0].strengths.push('Changed')
    copy.agents[0].weaknesses.push('Changed')
    copy.planner.maxParallel = 1
    copy.benchmark.enabled = false
    copy.autoPr.qualityGates.push('changed')
    copy.autoPr.securityGateExcludes.push('changed/**')
    copy.autoPr.labels.push('changed')
    copy.autoPr.reviewers.push('changed')

    expect(source).toEqual(original)
  })

  it('returns a profile accepted by workspaceProfileSchema', () => {
    const source = completeProfile()
    const copy = duplicateProfile(source, [source])

    expect(workspaceProfileSchema.parse(copy)).toEqual(copy)
  })
})
