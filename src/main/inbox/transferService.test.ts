import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ideaSchema } from '@shared/inbox'
import { DEFAULT_PROFILE, type WorkspaceProfile } from '@shared/profile'
import type { GithubAuthStatus } from '@shared/ipc'

const profileWithRepo: WorkspaceProfile = {
  ...DEFAULT_PROFILE,
  id: 'prof-1',
  workingDir: 'C:\\git\\demo',
  githubRepo: {
    owner: 'acme',
    repo: 'shop',
    defaultBranch: 'main',
    localPath: 'C:\\git\\demo',
    cloneStatus: 'cloned' as const
  }
}

const {
  spawnMock,
  seedMock,
  killMock,
  setGoalMock,
  snapshotMock,
  onSnapshotMock,
  offSnapshotMock,
  getProfileMock,
  checkGithubRepoLocalMock,
  githubAuthStatusMock
} = vi.hoisted(() => ({
  spawnMock: vi.fn(async () => [
    {
      id: 'orch-1',
      name: 'Aragorn',
      provider: 'claude',
      model: 'fable',
      kind: 'orchestrator',
      role: 'Orchestrator',
      mode: 'interactive',
      yolo: false,
      workingDir: 'C:\\git\\demo',
      status: 'running',
      startedAt: Date.now()
    },
    {
      id: 'sub-1',
      name: 'Legolas',
      provider: 'codex',
      model: '',
      kind: 'sub',
      role: 'Subagent',
      mode: 'interactive',
      yolo: false,
      workingDir: 'C:\\git\\demo',
      status: 'running',
      startedAt: Date.now()
    }
  ]),
  seedMock: vi.fn(async () => undefined),
  killMock: vi.fn(async () => undefined),
  setGoalMock: vi.fn(),
  snapshotMock: vi.fn(() => ({ goal: null, tasks: [], pendingPlan: undefined })),
  onSnapshotMock: vi.fn(),
  offSnapshotMock: vi.fn(),
  getProfileMock: vi.fn((id: string): WorkspaceProfile | undefined =>
    id === 'prof-1' ? profileWithRepo : undefined
  ),
  checkGithubRepoLocalMock: vi.fn(async () => ({
    localPath: 'C:\\git\\demo',
    cloneStatus: 'cloned',
    message: 'ok'
  })),
  githubAuthStatusMock: vi.fn(async (): Promise<GithubAuthStatus> => ({
    authenticated: true,
    needsReauth: false,
    missingScopes: [],
    method: 'gh-cli',
    scopes: ['repo'],
    oauthConfigured: false
  }))
}))

vi.mock('@main/config/store', () => ({
  getProfile: getProfileMock,
  saveProfile: vi.fn((p: WorkspaceProfile) => p),
  setActiveProfileId: vi.fn(),
  getActiveProfileId: vi.fn(() => 'prof-1')
}))

vi.mock('@main/integrations/githubRepo', () => ({
  checkGithubRepoLocal: checkGithubRepoLocalMock,
  bindGithubRepo: vi.fn()
}))

vi.mock('@main/integrations/githubAuth', () => ({
  githubAuthStatus: githubAuthStatusMock
}))

vi.mock('@main/agents/spawnProfile', () => ({
  spawnProfileTeam: spawnMock
}))

vi.mock('@main/agents/AgentManager', () => ({
  agentManager: { seedInteractive: seedMock, kill: killMock }
}))

vi.mock('@main/orchestrator/WorkspaceSessionRegistry', () => ({
  workspaceSessions: {
    getByProfile: vi.fn(() => ({
      engine: {
        setGoal: setGoalMock,
        snapshot: snapshotMock,
        on: onSnapshotMock,
        off: offSnapshotMock
      }
    }))
  }
}))

vi.mock('electron', () => ({
  app: { getPath: () => 'C:\\tmp\\orca-test' }
}))

import { __resetIdeasForTest } from '@main/inbox/store'
import {
  __clearTransferLocksForTest,
  retryIdeaTransfer,
  transferIdeaToProfile
} from '@main/inbox/transferService'

const baseIdea = ideaSchema.parse({
  id: 'idea-1',
  title: 'Feature X',
  content: 'Build feature X',
  status: 'ready',
  tags: [],
  artifacts: [],
  createdAt: 1,
  updatedAt: 1
})

describe('transferService', () => {
  beforeEach(() => {
    __clearTransferLocksForTest()
    __resetIdeasForTest([baseIdea])
    spawnMock.mockClear()
    seedMock.mockClear()
    killMock.mockClear()
    setGoalMock.mockClear()
    onSnapshotMock.mockClear()
    githubAuthStatusMock.mockResolvedValue({
      authenticated: true,
      needsReauth: false,
      missingScopes: [],
      method: 'gh-cli',
      scopes: ['repo'],
      oauthConfigured: false
    })
    getProfileMock.mockImplementation((id: string) => (id === 'prof-1' ? profileWithRepo : undefined))
    checkGithubRepoLocalMock.mockResolvedValue({
      localPath: 'C:\\git\\demo',
      cloneStatus: 'cloned',
      message: 'ok'
    })
  })

  it('rejects duplicate active transfer (idempotency)', async () => {
    __resetIdeasForTest([
      {
        ...baseIdea,
        transfer: {
          id: 'tr-1',
          status: 'running',
          profileId: 'prof-1',
          startedAt: 1,
          updatedAt: 1
        }
      }
    ])
    const first = await transferIdeaToProfile({ ideaId: 'idea-1', profileId: 'prof-1' })
    expect(first.duplicate).toBe(true)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('fails with needsClone when repo not cloned and clone not requested', async () => {
    const needsCloneProfile: WorkspaceProfile = {
      ...profileWithRepo,
      githubRepo: { ...profileWithRepo.githubRepo!, cloneStatus: 'linked' }
    }
    getProfileMock.mockReturnValueOnce(needsCloneProfile)
    checkGithubRepoLocalMock.mockResolvedValueOnce({
      localPath: 'C:\\git\\demo',
      cloneStatus: 'linked',
      message: 'bereit zum Klonen'
    })

    const result = await transferIdeaToProfile({ ideaId: 'idea-1', profileId: 'prof-1' })
    expect(result.transfer.status).toBe('failed')
    expect(result.transfer.action).toBe('needsClone')
    expect(result.transfer.retryable).toBe(true)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('rejects duplicate planned transfer (idempotency)', async () => {
    __resetIdeasForTest([
      {
        ...baseIdea,
        transfer: {
          id: 'tr-planned',
          status: 'planned',
          profileId: 'prof-1',
          planId: 'plan-1',
          startedAt: 1,
          updatedAt: 2
        }
      }
    ])
    const result = await transferIdeaToProfile({ ideaId: 'idea-1', profileId: 'prof-1' })
    expect(result.duplicate).toBe(true)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('fails with needsAuth when github is not authenticated for clone', async () => {
    const needsCloneProfile: WorkspaceProfile = {
      ...profileWithRepo,
      githubRepo: { ...profileWithRepo.githubRepo!, cloneStatus: 'linked' }
    }
    getProfileMock.mockReturnValueOnce(needsCloneProfile)
    checkGithubRepoLocalMock.mockResolvedValueOnce({
      localPath: 'C:\\git\\demo',
      cloneStatus: 'linked',
      message: 'bereit zum Klonen'
    })
    githubAuthStatusMock.mockResolvedValueOnce({
      authenticated: false,
      needsReauth: false,
      missingScopes: ['repo'],
      method: 'none',
      scopes: [],
      oauthConfigured: false
    })

    const result = await transferIdeaToProfile({ ideaId: 'idea-1', profileId: 'prof-1', clone: true })
    expect(result.transfer.status).toBe('failed')
    expect(result.transfer.action).toBe('needsAuth')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('starts workspace and seeds orchestrator on successful transfer', async () => {
    const result = await transferIdeaToProfile({ ideaId: 'idea-1', profileId: 'prof-1' })
    expect(result.transfer.status).toBe('running')
    expect(result.orchestratorAgentId).toBe('orch-1')
    expect(spawnMock).toHaveBeenCalledOnce()
    expect(setGoalMock).toHaveBeenCalledWith('Feature X')
    expect(onSnapshotMock).toHaveBeenCalled()
    await vi.waitFor(() => expect(seedMock).toHaveBeenCalled())
  })

  it('cleans up spawned agents before retry to avoid duplicate teams', async () => {
    __resetIdeasForTest([
      {
        ...baseIdea,
        transfer: {
          id: 'tr-stable',
          status: 'failed',
          profileId: 'prof-1',
          error: 'Timeout',
          retryable: true,
          startedAt: 1,
          updatedAt: 2
        }
      }
    ])
    await retryIdeaTransfer('idea-1')
    expect(killMock).not.toHaveBeenCalled()
    expect(spawnMock).toHaveBeenCalledOnce()
  })

  it('retries failed transfer with stable transfer id', async () => {
    __resetIdeasForTest([
      {
        ...baseIdea,
        transfer: {
          id: 'tr-stable',
          status: 'failed',
          profileId: 'prof-1',
          error: 'Klon fehlte',
          retryable: true,
          action: 'needsClone',
          startedAt: 1,
          updatedAt: 2
        }
      }
    ])
    const result = await retryIdeaTransfer('idea-1')
    expect(result.transfer.id).toBe('tr-stable')
    expect(result.transfer.status).toBe('running')
  })
})
