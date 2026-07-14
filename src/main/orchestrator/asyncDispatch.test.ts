import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_PROFILE } from '@shared/profile'
import type { AutoPrOutcome, PrepareTaskResult, RemoteCiOutcome } from '@main/integrations/autoPr'
import type { TaskRecoveryArtifact } from '@shared/orchestrator'

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

const { runTask, prepareTaskChange, publishPreparedChanges, captureTaskRecoveryArtifact } = vi.hoisted(() => ({
  runTask: vi.fn(),
  prepareTaskChange: vi.fn<(input: unknown) => Promise<PrepareTaskResult>>(async () => ({
    status: 'skipped',
    result: 'no-changes',
    noChanges: true,
    message: 'No-op bestätigt.'
  })),
  publishPreparedChanges: vi.fn<(
    input: { onRemoteCiUpdate?: (outcome: RemoteCiOutcome) => void }
  ) => Promise<AutoPrOutcome>>(),
  captureTaskRecoveryArtifact: vi.fn<(input: unknown) => Promise<TaskRecoveryArtifact | undefined>>(async () => undefined)
}))
vi.mock('@main/agents/AgentManager', () => ({
  agentManager: { runTask, list: () => [] }
}))
vi.mock('@main/integrations/autoPr', () => ({
  prepareTaskChange,
  publishPreparedChanges
}))
vi.mock('@main/orchestrator/recoveryArtifact', () => ({
  captureTaskRecoveryArtifact
}))

import { OrchestratorEngine, platformExecutionGuidance } from './Engine'

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
  it('defines the PowerShell execution contract independently of the host running tests', () => {
    const guidance = platformExecutionGuidance('win32').join('\n')

    expect(guidance).toContain('kurzen Einzelbefehl')
    expect(guidance).toContain("rg -g")
    expect(guidance).toContain('Exit-Code 1')
    expect(guidance).toContain('Quotingfehlern')
    expect(platformExecutionGuidance('darwin').join('\n')).toMatch(/zsh.*BSD/i)
    expect(platformExecutionGuidance('linux')).toEqual([])
  })

  it('returns taskId immediately and exposes the final result through polling', async () => {
    let finish!: (value: { result: string; isError: boolean; status: 'succeeded' }) => void
    runTask.mockImplementationOnce(async (request) => ({
      info: info(request.taskId),
      done: new Promise((resolve) => { finish = resolve })
    }))
    const engine = new OrchestratorEngine({ profile: { ...DEFAULT_PROFILE } })

    const accepted = engine.dispatchAsync('codex', 'Implement feature', 'Feature')
    expect(accepted.taskId).toMatch(/^t-/)
    expect(accepted).toEqual(expect.objectContaining({ title: 'Feature', provider: 'codex', role: expect.any(String) }))
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

  it('enables auto mode for a running review workspace and starts its pending plan', async () => {
    runTask.mockImplementation(async (request) => ({
      info: info(request.taskId),
      done: Promise.resolve({ result: 'Done', isError: false, status: 'succeeded' as const })
    }))
    const profile = {
      ...DEFAULT_PROFILE,
      planner: { ...DEFAULT_PROFILE.planner, mode: 'review' as const }
    }
    const engine = new OrchestratorEngine({ profile })
    const runTaskCallsBeforePlan = runTask.mock.calls.length
    const result = engine.executePlan({
      version: 1,
      goal: 'Promote this workspace',
      maxParallel: 1,
      tasks: [{
        id: 'one', title: 'One', role: 'codex', prompt: 'Work', dependsOn: [], conflictKeys: [],
        ownership: 'feature', expectedFiles: []
      }]
    })

    await vi.waitFor(() => expect(engine.snapshot().pendingPlan).toBeDefined())
    expect(engine.snapshot().plannerMode).toBe('review')
    expect(runTask).toHaveBeenCalledTimes(runTaskCallsBeforePlan)

    expect(engine.enableAutoMode()).toBe(true)
    expect(engine.snapshot()).toEqual(expect.objectContaining({
      plannerMode: 'auto',
      pendingPlan: undefined
    }))
    await expect(result).resolves.toEqual(expect.objectContaining({ status: 'success' }))

    const nextResult = await engine.executePlan({
      version: 1,
      goal: 'Stay automatic',
      maxParallel: 1,
      tasks: [{
        id: 'two', title: 'Two', role: 'codex', prompt: 'More work', dependsOn: [], conflictKeys: [],
        ownership: 'feature', expectedFiles: []
      }]
    })
    expect(nextResult.status).toBe('success')
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

  it('advertises routing knowledge and recovers with an untried role in adaptive mode', async () => {
    const recoveryWorktree = 'C:\\repo\\.orca-worktrees\\session\\agent'
    captureTaskRecoveryArtifact.mockResolvedValueOnce({
      worktree: recoveryWorktree,
      baseCommit: 'a'.repeat(40),
      changedFiles: ['src/main/partial.ts'],
      statusSummary: ' M src/main/partial.ts',
      capturedAt: Date.now()
    })
    runTask
      .mockImplementationOnce(async (request) => ({
        info: { ...info(request.taskId), provider: request.provider },
        done: Promise.resolve({ result: 'First role failed', isError: true, status: 'failed' as const })
      }))
      .mockImplementationOnce(async (request) => ({
        info: { ...info(request.taskId), provider: request.provider },
        done: Promise.resolve({ result: 'Recovered safely', isError: false, status: 'succeeded' as const })
      }))

    const profile = {
      ...DEFAULT_PROFILE,
      agents: [
        {
          role: 'implementation',
          provider: 'codex' as const,
          model: '',
          count: 1,
          orchestrated: true,
          yolo: false,
          strengths: ['repo-nahe Implementierung'],
          weaknesses: []
        },
        {
          role: 'review',
          provider: 'cursor' as const,
          model: 'composer',
          count: 1,
          orchestrated: true,
          yolo: false,
          strengths: ['schnelle Verifikation'],
          weaknesses: []
        }
      ],
      planner: {
        ...DEFAULT_PROFILE.planner,
        mode: 'auto' as const,
        routingMode: 'adaptive' as const,
        maxRetries: 1
      }
    }
    const engine = new OrchestratorEngine({ profile })

    expect(engine.listSubagents()).toEqual([
      expect.objectContaining({ role: 'implementation', strengths: ['repo-nahe Implementierung'] }),
      expect.objectContaining({ role: 'review', strengths: ['schnelle Verifikation'] })
    ])

    const result = await engine.executePlan({
      version: 1,
      goal: 'Recover the implementation',
      maxParallel: 1,
      tasks: [{
        id: 'work',
        title: 'Work',
        role: 'implementation',
        prompt: 'Implement and verify.',
        dependsOn: [],
        conflictKeys: [],
        ownership: 'feature',
        expectedFiles: []
      }]
    })

    expect(result.tasks[0]).toEqual(expect.objectContaining({ status: 'success' }))
    expect(runTask.mock.calls.slice(-2).map(([request]) => request.provider)).toEqual(['codex', 'cursor'])
    const retryRequest = runTask.mock.calls.at(-1)?.[0]
    expect(retryRequest).toEqual(expect.objectContaining({ recoveryWorktree }))
    expect(retryRequest?.prompt).toContain('Recovery-Artefakt')
    expect(captureTaskRecoveryArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ baseCommit: undefined, worktree: '.' })
    )
  })


  it('shows live plan nodes and derives failure from required child state', async () => {
    let finish!: (value: { result: string; isError: boolean; status: 'failed' }) => void
    runTask.mockImplementationOnce(async (request) => ({
      info: info(request.taskId),
      done: new Promise((resolve) => { finish = resolve })
    }))
    const profile = {
      ...DEFAULT_PROFILE,
      planner: { ...DEFAULT_PROFILE.planner, mode: 'auto' as const, maxRetries: 0 }
    }
    const engine = new OrchestratorEngine({ profile })
    const started = engine.executePlanAsync({
      version: 1,
      goal: 'Truthful live plan',
      maxParallel: 1,
      tasks: [{
        id: 'required', title: 'Required delivery', role: 'codex', prompt: 'Fail explicitly.',
        dependsOn: [], advisoryDependsOn: [], criticality: 'required', conflictKeys: [],
        ownership: 'feature', expectedFiles: []
      }]
    })

    await vi.waitFor(() => {
      expect(engine.getPlanRunStatus(started.runId)?.tasks?.[0]).toEqual(
        expect.objectContaining({
          planTaskId: 'required',
          status: 'running',
          lastAction: expect.any(String),
          lastHeartbeatAt: expect.any(Number)
        })
      )
    })
    finish({ result: 'Worker failed', isError: true, status: 'failed' })
    await vi.waitFor(() => expect(engine.getPlanRunStatus(started.runId)?.status).toBe('error'))
    expect(engine.getPlanRunStatus(started.runId)?.summary).toEqual(
      expect.objectContaining({ required: 1, failed: 1 })
    )
    expect(engine.snapshot().reliability?.preventedFalseSuccesses).toBe(1)
  })

  it('allows advisory failure without turning verified required work red', async () => {
    runTask.mockImplementation(async (request) => ({
      info: info(request.taskId),
      done: Promise.resolve(
        request.prompt.includes('Advisory audit')
          ? { result: 'Audit unavailable', isError: true, status: 'failed' as const }
          : { result: 'Delivery verified', isError: false, status: 'succeeded' as const }
      )
    }))
    const profile = {
      ...DEFAULT_PROFILE,
      planner: { ...DEFAULT_PROFILE.planner, mode: 'auto' as const, maxRetries: 0 }
    }
    const engine = new OrchestratorEngine({ profile })
    const result = await engine.executePlan({
      version: 1,
      goal: 'Advisory semantics',
      maxParallel: 1,
      tasks: [
        {
          id: 'audit', title: 'Optional audit', role: 'codex', prompt: 'Advisory audit',
          dependsOn: [], advisoryDependsOn: [], criticality: 'advisory', conflictKeys: [],
          ownership: 'feature', expectedFiles: []
        },
        {
          id: 'delivery', title: 'Required delivery', role: 'codex', prompt: 'Required work',
          dependsOn: [], advisoryDependsOn: ['audit'], criticality: 'required', conflictKeys: [],
          ownership: 'feature', expectedFiles: []
        }
      ]
    })

    expect(result.status).toBe('success')
    expect(result.tasks).toEqual([
      expect.objectContaining({ id: 'audit', status: 'error', criticality: 'advisory' }),
      expect.objectContaining({ id: 'delivery', status: 'success', criticality: 'required' })
    ])
  })

  it('surfaces a partial central commit as needs-work with findings', async () => {
    runTask.mockImplementationOnce(async (request) => ({
      info: info(request.taskId),
      done: Promise.resolve({ result: 'Implemented', isError: false, status: 'succeeded' as const })
    }))
    prepareTaskChange.mockResolvedValueOnce({
      status: 'blocked',
      result: 'needs-work',
      message: 'Partial commit retained.',
      branch: 'orca/partial',
      worktree: '.',
      change: {
        taskId: 'partial',
        title: 'Sensitive feature',
        worktree: '.',
        branch: 'orca/partial',
        commit: 'b'.repeat(40),
        commits: ['b'.repeat(40)],
        files: ['src/main/ipc/sensitive.ts']
      },
      findings: [{
        gate: 'security',
        code: 'missing-ipc-controls',
        message: 'authorization, validation',
        files: ['src/main/ipc/sensitive.ts']
      }]
    })
    const profile = {
      ...DEFAULT_PROFILE,
      planner: { ...DEFAULT_PROFILE.planner, mode: 'auto' as const, maxRetries: 0 }
    }
    const engine = new OrchestratorEngine({ profile })
    const result = await engine.executePlan({
      version: 1,
      goal: 'Preserve partial value',
      maxParallel: 1,
      tasks: [{
        id: 'partial', title: 'Sensitive feature', role: 'codex', prompt: 'Implement IPC.',
        dependsOn: [], advisoryDependsOn: [], criticality: 'required', conflictKeys: [],
        ownership: 'feature', expectedFiles: ['src/main/ipc/sensitive.ts']
      }]
    })

    expect(result.status).toBe('needs-work')
    expect(result.tasks[0]).toEqual(expect.objectContaining({
      status: 'needs-work',
      commit: 'b'.repeat(40),
      findings: [expect.objectContaining({ code: 'missing-ipc-controls' })]
    }))
  })
})
