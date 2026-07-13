import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_PROFILE } from '@shared/profile'
import type { AutoPrOutcome, PrepareTaskResult, RemoteCiOutcome } from '@main/integrations/autoPr'

vi.mock('electron', () => ({
  app: { getPath: () => '.', getName: () => 'test', isPackaged: false },
  BrowserWindow: class {},
  shell: { openExternal: vi.fn() }
}))

vi.mock('@main/windows', () => ({ createPaneWindow: vi.fn(), broadcast: vi.fn() }))
vi.mock('@main/config/store', () => ({
  getProfile: () => DEFAULT_PROFILE,
  getActiveProfileId: () => 'default',
  getSetting: () => undefined,
  setSetting: vi.fn()
}))

const { runTask, prepareTaskChange, publishPreparedChanges } = vi.hoisted(() => ({
  runTask: vi.fn(),
  prepareTaskChange: vi.fn<(input: unknown) => Promise<PrepareTaskResult>>(async () => ({
    status: 'skipped',
    result: 'no-changes',
    noChanges: true,
    message: 'No-op bestätigt.'
  })),
  publishPreparedChanges: vi.fn<(
    input: { onRemoteCiUpdate?: (outcome: RemoteCiOutcome) => void }
  ) => Promise<AutoPrOutcome>>()
}))
vi.mock('@main/agents/AgentManager', () => ({
  agentManager: { runTask, list: () => [] }
}))
vi.mock('@main/integrations/autoPr', () => ({
  prepareTaskChange,
  publishPreparedChanges
}))

import { OrchestratorEngine } from './Engine'

function info(taskId: string) {
  return {
    id: `agent-${taskId}`,
    name: 'Legolas',
    provider: 'codex' as const,
    model: '',
    role: 'Task · worker',
    kind: 'sub' as const,
    mode: 'task' as const,
    taskId,
    yolo: false,
    workingDir: '.',
    worktree: '.',
    status: 'running' as const,
    startedAt: Date.now()
  }
}

describe('asynchronous orchestration API', () => {
  it('returns taskId immediately and exposes the final result through polling', async () => {
    let finish!: (value: { result: string; isError: boolean; status: 'succeeded' }) => void
    runTask.mockImplementationOnce(async (request) => ({
      info: info(request.taskId),
      done: new Promise((resolve) => { finish = resolve })
    }))
    const engine = new OrchestratorEngine({ profile: { ...DEFAULT_PROFILE } })

    const accepted = engine.dispatchAsync('codex', 'Implement feature', 'Feature')
    expect(accepted.taskId).toMatch(/^t-/)
    expect(accepted).toEqual(expect.objectContaining({ title: 'Feature', role: expect.any(String) }))
    expect(['queued', 'running']).toContain(accepted.status)
    await vi.waitFor(() => expect(runTask).toHaveBeenCalledTimes(1))

    finish({ result: 'Committed abc', isError: false, status: 'succeeded' })
    await vi.waitFor(() => expect(engine.getTaskStatus(accepted.taskId)?.status).toBe('success'))
    expect(engine.getTaskStatus(accepted.taskId)).toEqual(
      expect.objectContaining({ result: expect.stringContaining('Committed abc'), completion: { kind: 'no-changes' } })
    )
    expect(engine.getTaskStatus(accepted.taskId)).toEqual(expect.objectContaining({
      agentName: 'Legolas',
      title: 'Feature',
      role: accepted.role
    }))
    expect(engine.snapshot().activity?.phase).toBe('summarizing')
  })

  it('propagates remote CI failures without losing the published PR state', async () => {
    runTask.mockImplementationOnce(async (request) => ({
      info: info(request.taskId),
      done: Promise.resolve({ result: 'Done', isError: false, status: 'succeeded' as const })
    }))
    prepareTaskChange.mockResolvedValueOnce({
      status: 'prepared',
      result: 'committed',
      noChanges: false,
      message: 'Commit verified.',
      branch: 'orca/test',
      worktree: '.',
      change: {
        taskId: 'worker',
        title: 'Feature',
        worktree: '.',
        branch: 'orca/test',
        commit: 'a'.repeat(40),
        commits: ['a'.repeat(40)],
        files: ['feature.ts']
      }
    })
    publishPreparedChanges.mockImplementationOnce(async (input) => {
      input.onRemoteCiUpdate?.({
        status: 'pending',
        message: '1 Remote-Check läuft.',
        url: 'https://checks/pending'
      })
      return {
        status: 'published',
        message: 'PR published. Remote-CI failed.',
        url: 'https://github.test/pr/1',
        remoteCi: {
          status: 'failed',
          message: 'Remote-CI fehlgeschlagen: CI.',
          url: 'https://checks/fail'
        }
      }
    })
    const profile = {
      ...DEFAULT_PROFILE,
      autoPr: { ...DEFAULT_PROFILE.autoPr, mode: 'draft-after-checks' as const }
    }
    const engine = new OrchestratorEngine({ profile })
    const accepted = engine.dispatchAsync('codex', 'Implement feature', 'Feature')

    await vi.waitFor(() => {
      const task = engine.snapshot().tasks.find((candidate) => candidate.id === accepted.taskId)
      expect(task?.remoteCiStatus).toBe('failed')
    })

    const task = engine.snapshot().tasks.find((candidate) => candidate.id === accepted.taskId)
    const integration = engine.snapshot().tasks.find((candidate) => candidate.role === 'integrator')
    expect(task).toEqual(expect.objectContaining({
      status: 'success',
      autoPrStatus: 'published',
      prUrl: 'https://github.test/pr/1',
      remoteCiStatus: 'failed',
      remoteCiUrl: 'https://checks/fail'
    }))
    expect(integration).toEqual(expect.objectContaining({
      status: 'error',
      phase: 'testing',
      autoPrStatus: 'published',
      remoteCiStatus: 'failed'
    }))
  })

  it('starts a full plan asynchronously and makes its terminal result pollable', async () => {
    runTask.mockImplementation(async (request) => ({
      info: info(request.taskId),
      done: Promise.resolve({ result: 'Done', isError: false, status: 'succeeded' as const })
    }))
    const profile = { ...DEFAULT_PROFILE, planner: { ...DEFAULT_PROFILE.planner, mode: 'auto' as const } }
    const engine = new OrchestratorEngine({ profile })
    const started = engine.executePlanAsync({
      version: 1,
      goal: 'Async plan',
      maxParallel: 1,
      tasks: [{
        id: 'one', title: 'One', role: 'codex', prompt: 'Work', dependsOn: [], conflictKeys: [],
        ownership: 'feature', expectedFiles: []
      }]
    })

    expect(started.status).toBe('running')
    await vi.waitFor(() => expect(engine.getPlanRunStatus(started.runId)?.status).toBe('success'))
    expect(engine.getPlanRunStatus(started.runId)?.result?.tasks[0]?.status).toBe('success')
  })
})
