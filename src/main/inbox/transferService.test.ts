import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ideaSchema } from '@shared/inbox'
import { DEFAULT_PROFILE, type WorkspaceProfile } from '@shared/profile'

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
  writeMock,
  setGoalMock,
  snapshotMock,
  onSnapshotMock,
  offSnapshotMock,
  getProfileMock,
  checkGithubRepoLocalMock
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
    }
  ]),
  writeMock: vi.fn(),
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
  githubAuthStatus: vi.fn(async () => ({ authenticated: true, needsReauth: false }))
}))

vi.mock('@main/agents/spawnProfile', () => ({
  spawnProfileTeam: spawnMock
}))

vi.mock('@main/agents/AgentManager', () => ({
  agentManager: { write: writeMock }
}))

vi.mock('@main/orchestrator/Engine', () => ({
  orchestratorEngine: {
    setGoal: setGoalMock,
    snapshot: snapshotMock,
    on: onSnapshotMock,
    off: offSnapshotMock
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
    writeMock.mockClear()
    setGoalMock.mockClear()
    onSnapshotMock.mockClear()
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

  it('starts workspace and seeds orchestrator on successful transfer', async () => {
    const result = await transferIdeaToProfile({ ideaId: 'idea-1', profileId: 'prof-1' })
    expect(result.transfer.status).toBe('running')
    expect(result.orchestratorAgentId).toBe('orch-1')
    expect(spawnMock).toHaveBeenCalledOnce()
    expect(setGoalMock).toHaveBeenCalledWith('Feature X')
    expect(onSnapshotMock).toHaveBeenCalled()
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
