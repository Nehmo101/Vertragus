import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PROFILE } from '@shared/profile'

vi.mock('electron', () => ({
  app: { getPath: () => '.', getName: () => 'test', isPackaged: false }
}))
vi.mock('@main/windows', () => ({ createPaneWindow: vi.fn(), broadcast: vi.fn() }))
vi.mock('@main/config/store', () => ({
  getProfile: () => DEFAULT_PROFILE,
  getActiveProfileId: () => 'default',
  getSetting: () => undefined,
  setSetting: vi.fn(),
  listMcpServers: () => []
}))

const { runTask } = vi.hoisted(() => ({ runTask: vi.fn() }))
vi.mock('@main/agents/AgentManager', () => ({
  agentManager: { runTask, list: () => [] }
}))
vi.mock('@main/integrations/autoPr', () => ({
  prepareTaskChange: vi.fn(async () => ({
    status: 'skipped',
    result: 'no-changes',
    noChanges: true,
    message: 'No-op bestätigt.'
  })),
  publishPreparedChanges: vi.fn()
}))
vi.mock('@main/orchestrator/recoveryArtifact', () => ({
  captureTaskRecoveryArtifact: vi.fn(async () => undefined)
}))

import { OrchestratorEngine } from './Engine'
import { setMcpHandle } from './mcpHandle'

function agentInfo(taskId: string) {
  return {
    id: `agent-${taskId}`,
    name: 'Nesso',
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

function pendingRun(): { finish: (result: { result: string; isError: boolean; status: 'succeeded' }) => void } {
  const controller = { finish: undefined as unknown as (result: { result: string; isError: boolean; status: 'succeeded' }) => void }
  runTask.mockImplementationOnce(async (request: { taskId: string }) => ({
    info: agentInfo(request.taskId),
    done: new Promise((resolve) => {
      controller.finish = resolve as typeof controller.finish
    })
  }))
  return controller
}

afterEach(() => {
  setMcpHandle(null)
  runTask.mockReset()
})

describe('subagent communication channel', () => {
  it('report_progress updates the live task snapshot with the worker-authored action', async () => {
    const run = pendingRun()
    const engine = new OrchestratorEngine({ profile: { ...DEFAULT_PROFILE } })
    const accepted = engine.dispatchAsync('codex', 'Implement feature', 'Feature')
    await vi.waitFor(() => expect(runTask).toHaveBeenCalledTimes(1))

    const status = engine.reportSubagentProgress(accepted.taskId, {
      message: 'Schreibe Integrationstests',
      phase: 'testing'
    })
    expect(status).toEqual(
      expect.objectContaining({
        lastAction: 'Worker meldet: Schreibe Integrationstests',
        phase: 'testing'
      })
    )
    expect(engine.getTaskStatus(accepted.taskId)?.recentActions?.[0]).toBe(
      'Worker meldet: Schreibe Integrationstests'
    )
    expect(engine.reportSubagentProgress('missing', { message: 'x' })).toBeUndefined()

    run.finish({ result: 'Done', isError: false, status: 'succeeded' })
    await vi.waitFor(() => expect(engine.getTaskStatus(accepted.taskId)?.status).toBe('success'))
  })

  it('shares findings between parallel tasks through the bounded board', async () => {
    const first = pendingRun()
    const second = pendingRun()
    const engine = new OrchestratorEngine({ profile: { ...DEFAULT_PROFILE } })
    const taskA = engine.dispatchAsync('codex', 'Baue Modul A', 'Modul A')
    const taskB = engine.dispatchAsync('codex', 'Baue Modul B', 'Modul B')
    await vi.waitFor(() => expect(runTask).toHaveBeenCalledTimes(2))

    const finding = engine.postTaskFinding(taskA.taskId, {
      kind: 'interface',
      title: 'API-Vertrag Modul A',
      detail: 'export function moduleA(input: string): Promise<Result>',
      files: ['src/moduleA.ts']
    })
    expect(finding.taskId).toBe(taskA.taskId)

    const visibleToB = engine.listTaskFindings(taskB.taskId)
    expect(visibleToB).toEqual([
      expect.objectContaining({
        kind: 'interface',
        title: 'API-Vertrag Modul A',
        agentName: 'Nesso',
        files: ['src/moduleA.ts']
      })
    ])
    // The orchestrator view (no task scope) sees the complete board, and the
    // snapshot carries it into the renderer.
    expect(engine.listTaskFindings()).toHaveLength(1)
    expect(engine.snapshot().findings).toEqual([
      expect.objectContaining({ title: 'API-Vertrag Modul A' })
    ])

    expect(() => engine.postTaskFinding('missing', { kind: 'insight', title: 't', detail: 'd' }))
      .toThrowError('Task nicht gefunden.')
    expect(() => engine.postTaskFinding(taskA.taskId, { kind: 'insight', title: '  ', detail: 'd' }))
      .toThrowError('Finding benötigt Titel und Inhalt.')

    first.finish({ result: 'Done', isError: false, status: 'succeeded' })
    second.finish({ result: 'Done', isError: false, status: 'succeeded' })
    await vi.waitFor(() => expect(engine.getTaskStatus(taskB.taskId)?.status).toBe('success'))
  })

  it('mentions the communication tools in the execution contract only when they are attached', async () => {
    setMcpHandle({
      url: 'http://127.0.0.1:1/mcp?token=a',
      subagentUrl: 'http://127.0.0.1:1/mcp?token=b',
      allowedTools: [],
      close: async () => {}
    })
    const withTools = pendingRun()
    const engine = new OrchestratorEngine({ profile: { ...DEFAULT_PROFILE } })
    const first = engine.dispatchAsync('codex', 'Aufgabe', 'Mit Tools')
    await vi.waitFor(() => expect(runTask).toHaveBeenCalledTimes(1))
    expect(runTask.mock.calls[0]![0].prompt).toContain('report_progress')
    expect(runTask.mock.calls[0]![0].prompt).toContain('post_finding')
    withTools.finish({ result: 'Done', isError: false, status: 'succeeded' })
    await vi.waitFor(() => expect(engine.getTaskStatus(first.taskId)?.status).toBe('success'))

    setMcpHandle(null)
    const withoutTools = pendingRun()
    const second = engine.dispatchAsync('codex', 'Aufgabe', 'Ohne Tools')
    await vi.waitFor(() => expect(runTask).toHaveBeenCalledTimes(2))
    expect(runTask.mock.calls[1]![0].prompt).not.toContain('report_progress')
    withoutTools.finish({ result: 'Done', isError: false, status: 'succeeded' })
    await vi.waitFor(() => expect(engine.getTaskStatus(second.taskId)?.status).toBe('success'))
  })

  it('restores the findings board and resumes id sequences after a restart', async () => {
    const persistedSnapshot = {
      goal: null,
      tasks: [
        { id: 't-3', title: 'Alte Aufgabe', role: 'codex', status: 'success', createdAt: 1 }
      ],
      findings: [
        {
          id: 'finding-5',
          taskId: 't-3',
          kind: 'interface',
          title: 'Alt-API',
          detail: 'export function legacy(): void',
          createdAt: 1
        }
      ]
    } as unknown as import('@shared/orchestrator').OrchestratorSnapshot
    const run = pendingRun()
    const engine = new OrchestratorEngine({
      profile: { ...DEFAULT_PROFILE },
      persistence: { readSnapshot: () => persistedSnapshot, writeSnapshot: vi.fn() }
    })

    expect(engine.listTaskFindings()).toEqual([
      expect.objectContaining({ id: 'finding-5', title: 'Alt-API' })
    ])

    // New ids must continue AFTER the restored ones instead of overwriting them.
    const accepted = engine.dispatchAsync('codex', 'Neue Aufgabe', 'Neu')
    expect(accepted.taskId).toBe('t-4')
    expect(engine.getTaskStatus('t-3')?.title).toBe('Alte Aufgabe')
    await vi.waitFor(() => expect(runTask).toHaveBeenCalledTimes(1))

    const fresh = engine.postTaskFinding(accepted.taskId, {
      kind: 'decision',
      title: 'Neue Entscheidung',
      detail: 'Wir erweitern die Alt-API.'
    })
    expect(fresh.id).toBe('finding-6')
    expect(engine.listTaskFindings()).toHaveLength(2)

    run.finish({ result: 'Done', isError: false, status: 'succeeded' })
    await vi.waitFor(() => expect(engine.getTaskStatus(accepted.taskId)?.status).toBe('success'))
  })

  it('continues a restart-interrupted task in its preserved worktree', async () => {
    const worktree = '/repo/.vertragus-worktrees/session-1/codex-01'
    const persistedSnapshot = {
      goal: { id: 'goal-1', title: 'Ziel', active: true },
      tasks: [
        {
          id: 't-7',
          title: 'Unterbrochene Aufgabe',
          role: 'codex',
          status: 'running',
          createdAt: 1,
          worktree
        }
      ],
      dispatchRecords: {
        't-7': { role: 'codex', prompt: 'Mach weiter', title: 'Unterbrochene Aufgabe', options: {} }
      }
    } as unknown as import('@shared/orchestrator').OrchestratorSnapshot
    const writeSnapshot = vi.fn()
    const run = pendingRun()
    const engine = new OrchestratorEngine({
      profile: { ...DEFAULT_PROFILE },
      persistence: { readSnapshot: () => persistedSnapshot, writeSnapshot }
    })

    // Restored as terminal + interrupted; the flag never reaches live pushes,
    // but the persisted file keeps carrying the dispatch prompt.
    const restored = engine.snapshot().tasks.find((task) => task.id === 't-7')
    expect(restored).toMatchObject({ status: 'stopped', interrupted: true })
    expect(engine.snapshot().dispatchRecords).toBeUndefined()

    expect(engine.resumeInterruptedTask('t-7')).toBe(true)
    // A second click while the continuation runs must not double-dispatch.
    expect(engine.resumeInterruptedTask('t-7')).toBe(false)
    await vi.waitFor(() => expect(runTask).toHaveBeenCalledTimes(1))
    expect(runTask.mock.calls[0]![0]).toMatchObject({
      taskId: 't-7',
      prompt: expect.stringContaining('Mach weiter'),
      recoveryWorktree: worktree
    })
    await vi.waitFor(() =>
      expect(writeSnapshot).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          dispatchRecords: expect.objectContaining({
            't-7': expect.objectContaining({ prompt: 'Mach weiter' })
          })
        })
      )
    )

    run.finish({ result: 'Done', isError: false, status: 'succeeded' })
    await vi.waitFor(() => expect(engine.getTaskStatus('t-7')?.status).toBe('success'))
  })

  it('keeps concurrent plan runs and their goals separate', async () => {
    runTask.mockImplementation(async (request: { taskId: string }) => ({
      info: agentInfo(request.taskId),
      done: Promise.resolve({ result: 'Done', isError: false, status: 'succeeded' as const })
    }))
    const profile = {
      ...DEFAULT_PROFILE,
      planner: { ...DEFAULT_PROFILE.planner, mode: 'auto' as const }
    }
    const engine = new OrchestratorEngine({ profile })
    const planTask = {
      id: 'one', title: 'One', role: 'codex', prompt: 'Work', dependsOn: [],
      advisoryDependsOn: [], criticality: 'required', conflictKeys: [],
      ownership: 'feature', expectedFiles: []
    }
    const runA = engine.executePlanAsync({ version: 1, goal: 'Ziel A', maxParallel: 1, tasks: [planTask] })
    const runB = engine.executePlanAsync({ version: 1, goal: 'Ziel B', maxParallel: 1, tasks: [planTask] })

    expect(runA.runId).not.toBe(runB.runId)
    await vi.waitFor(() => {
      expect(engine.getPlanRunStatus(runA.runId)?.status).toBe('success')
      expect(engine.getPlanRunStatus(runB.runId)?.status).toBe('success')
    })
    expect(engine.getPlanRunStatus(runA.runId)?.goal).toBe('Ziel A')
    expect(engine.getPlanRunStatus(runB.runId)?.goal).toBe('Ziel B')
  })
})
