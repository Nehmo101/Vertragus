import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

const { runTask, kill, prepareTaskChange, publishPreparedChanges, captureTaskRecoveryArtifact } = vi.hoisted(() => ({
  runTask: vi.fn(),
  kill: vi.fn(async () => undefined),
  prepareTaskChange: vi.fn<(input: unknown) => Promise<PrepareTaskResult>>(),
  publishPreparedChanges: vi.fn<(
    input: { onRemoteCiUpdate?: (outcome: RemoteCiOutcome) => void }
  ) => Promise<AutoPrOutcome>>(),
  captureTaskRecoveryArtifact: vi.fn<(input: unknown) => Promise<TaskRecoveryArtifact | undefined>>()
}))
vi.mock('@main/agents/AgentManager', () => ({
  agentManager: { runTask, kill, list: () => [] }
}))
vi.mock('@main/integrations/autoPr', () => ({
  prepareTaskChange,
  publishPreparedChanges
}))
vi.mock('@main/orchestrator/recoveryArtifact', () => ({
  captureTaskRecoveryArtifact
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

/** A worker that resolves only when the returned `finish` callback is invoked. */
function manualWorker() {
  let finish!: (value: { result: string; isError: boolean; status: 'succeeded' | 'failed' | 'cancelled' }) => void
  runTask.mockImplementationOnce(async (request) => ({
    info: info(request.taskId),
    done: new Promise((resolve) => { finish = resolve })
  }))
  return () => finish
}

/** A worker whose `done` promise never settles (stays running until killed). */
function stuckWorker() {
  runTask.mockImplementationOnce(async (request) => ({
    info: info(request.taskId),
    done: new Promise<never>(() => {})
  }))
}

function autoProfile(maxRetries = 0) {
  return {
    ...DEFAULT_PROFILE,
    planner: { ...DEFAULT_PROFILE.planner, mode: 'auto' as const, maxRetries }
  }
}

function planInput(id: string, goal: string) {
  return {
    version: 1 as const,
    goal,
    maxParallel: 1,
    tasks: [{
      id, title: id, role: 'codex', prompt: `Work on ${id}.`,
      dependsOn: [], advisoryDependsOn: [], criticality: 'required' as const,
      conflictKeys: [], ownership: 'feature' as const, expectedFiles: []
    }]
  }
}

/** Give queued microtasks a couple of ticks to flush without advancing timers. */
async function flush() {
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  runTask.mockReset()
  kill.mockReset()
  kill.mockImplementation(async () => undefined)
  prepareTaskChange.mockReset()
  prepareTaskChange.mockImplementation(async () => ({
    status: 'skipped',
    result: 'no-changes',
    noChanges: true,
    message: 'No-op bestätigt.'
  }))
  publishPreparedChanges.mockReset()
  captureTaskRecoveryArtifact.mockReset()
  captureTaskRecoveryArtifact.mockImplementation(async () => undefined)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('awaitTask', () => {
  it('returns immediately when the task is already terminal', async () => {
    runTask.mockImplementationOnce(async (request) => ({
      info: info(request.taskId),
      done: Promise.resolve({ result: 'Committed abc', isError: false, status: 'succeeded' as const })
    }))
    const engine = new OrchestratorEngine({ profile: { ...DEFAULT_PROFILE } })
    const accepted = engine.dispatchAsync('codex', 'Implement feature', 'Feature')
    await vi.waitFor(() => expect(engine.getTaskStatus(accepted.taskId)?.status).toBe('success'))

    const result = await engine.awaitTask(accepted.taskId)
    expect(result).toEqual(expect.objectContaining({ done: true, stillRunning: false }))
    expect(result).toMatchObject({ task: { taskId: accepted.taskId, status: 'success' } })
  })

  it('blocks until the worker finishes, then resolves with the terminal result', async () => {
    const finishOf = manualWorker()
    const engine = new OrchestratorEngine({ profile: { ...DEFAULT_PROFILE } })
    const accepted = engine.dispatchAsync('codex', 'Implement feature', 'Feature')
    await vi.waitFor(() => expect(engine.getTaskStatus(accepted.taskId)?.status).toBe('running'))

    const pending = engine.awaitTask(accepted.taskId)
    let settled = false
    void pending.then(() => { settled = true })
    await flush()
    expect(settled).toBe(false)

    finishOf()({ result: 'Committed abc', isError: false, status: 'succeeded' })
    const result = await pending
    expect(result.done).toBe(true)
    expect(result).toMatchObject({ task: { status: 'success', result: expect.stringContaining('Committed abc') } })
  })

  it('returns stillRunning on the long-poll timeout, then resolves on re-await', async () => {
    stuckWorker()
    const engine = new OrchestratorEngine({ profile: { ...DEFAULT_PROFILE } })
    const accepted = engine.dispatchAsync('codex', 'Never finishes', 'Never')
    await vi.waitFor(() => expect(engine.getTaskStatus(accepted.taskId)?.status).toBe('running'))

    vi.useFakeTimers()
    const pending = engine.awaitTask(accepted.taskId, 1_000)
    await vi.advanceTimersByTimeAsync(1_000)
    const timedOut = await pending
    vi.useRealTimers()

    expect(timedOut).toEqual(expect.objectContaining({ done: false, stillRunning: true, reason: 'timeout' }))
    expect(timedOut).toMatchObject({ task: { taskId: accepted.taskId, status: 'running' } })
  })

  it('reports an unknown taskId without throwing', async () => {
    const engine = new OrchestratorEngine({ profile: { ...DEFAULT_PROFILE } })
    await expect(engine.awaitTask('t-nope')).resolves.toEqual({
      done: false,
      stillRunning: false,
      reason: 'unknown',
      taskId: 't-nope'
    })
  })
})

describe('awaitAnyTask', () => {
  it('resolves with the first task to finish plus the still-open ids', async () => {
    const finishFirst = manualWorker()
    stuckWorker()
    const engine = new OrchestratorEngine({ profile: { ...DEFAULT_PROFILE } })
    const first = engine.dispatchAsync('codex', 'First worker', 'First')
    const second = engine.dispatchAsync('codex', 'Second worker', 'Second')
    await vi.waitFor(() => expect(engine.getTaskStatus(first.taskId)?.status).toBe('running'))

    const pending = engine.awaitAnyTask([first.taskId, second.taskId])
    finishFirst()({ result: 'First done', isError: false, status: 'succeeded' })
    const result = await pending

    expect(result.done).toBe(true)
    expect(result).toMatchObject({ task: { taskId: first.taskId, status: 'success' }, pending: [second.taskId] })
  })

  it('returns stillRunning with every snapshot on timeout', async () => {
    stuckWorker()
    stuckWorker()
    const engine = new OrchestratorEngine({ profile: { ...DEFAULT_PROFILE } })
    const a = engine.dispatchAsync('codex', 'A', 'A')
    const b = engine.dispatchAsync('codex', 'B', 'B')
    await vi.waitFor(() => expect(engine.getTaskStatus(a.taskId)?.status).toBe('running'))

    vi.useFakeTimers()
    const pending = engine.awaitAnyTask([a.taskId, b.taskId], 1_000)
    await vi.advanceTimersByTimeAsync(1_000)
    const result = await pending
    vi.useRealTimers()

    expect(result).toEqual(expect.objectContaining({ done: false, stillRunning: true, reason: 'timeout' }))
    expect(result.done === false && result.stillRunning ? result.tasks.map((t) => t.taskId) : []).toEqual(
      [a.taskId, b.taskId]
    )
  })

  it('reports all-unknown ids without throwing', async () => {
    const engine = new OrchestratorEngine({ profile: { ...DEFAULT_PROFILE } })
    await expect(engine.awaitAnyTask(['t-x', 't-y'])).resolves.toEqual({
      done: false,
      stillRunning: false,
      reason: 'unknown',
      unknownTaskIds: ['t-x', 't-y']
    })
  })
})

describe('awaitPlan', () => {
  it('blocks until the plan run reaches a terminal status', async () => {
    const finishOf = manualWorker()
    const engine = new OrchestratorEngine({ profile: autoProfile() })
    const started = engine.executePlanAsync(planInput('one', 'Async plan'))
    await vi.waitFor(() => expect(engine.getPlanRunStatus(started.runId)?.tasks?.[0]?.status).toBe('running'))

    const pending = engine.awaitPlan(started.runId)
    let settled = false
    void pending.then(() => { settled = true })
    await flush()
    expect(settled).toBe(false)

    finishOf()({ result: 'Worker done', isError: false, status: 'succeeded' })
    const result = await pending
    expect(result.done).toBe(true)
    expect(result).toMatchObject({ plan: { runId: started.runId, status: 'success' } })
  })

  it('returns stillRunning on the long-poll timeout for a running plan', async () => {
    stuckWorker()
    const engine = new OrchestratorEngine({ profile: autoProfile() })
    const started = engine.executePlanAsync(planInput('slow', 'Slow plan'))
    await vi.waitFor(() => expect(engine.getPlanRunStatus(started.runId)?.tasks?.[0]?.status).toBe('running'))

    vi.useFakeTimers()
    const pending = engine.awaitPlan(started.runId, 1_000)
    await vi.advanceTimersByTimeAsync(1_000)
    const result = await pending
    vi.useRealTimers()

    expect(result).toEqual(expect.objectContaining({ done: false, stillRunning: true, reason: 'timeout' }))
    expect(result).toMatchObject({ plan: { runId: started.runId, status: 'running' } })
  })

  it('reports an unknown runId without throwing', async () => {
    const engine = new OrchestratorEngine({ profile: autoProfile() })
    await expect(engine.awaitPlan('plan-run-nope')).resolves.toEqual({
      done: false,
      stillRunning: false,
      reason: 'unknown',
      runId: 'plan-run-nope'
    })
  })

  it('resolves as terminal after the plan run is cancelled', async () => {
    const finishOf = manualWorker()
    kill.mockImplementationOnce(async () => {
      finishOf()({ result: 'Task abgebrochen', isError: true, status: 'cancelled' })
    })
    const engine = new OrchestratorEngine({ profile: autoProfile() })
    const started = engine.executePlanAsync(planInput('running', 'Cancel running'))
    await vi.waitFor(() => expect(engine.getPlanRunStatus(started.runId)?.tasks?.[0]?.status).toBe('running'))

    await expect(engine.cancelPlan(started.runId)).resolves.toEqual(expect.objectContaining({ ok: true, status: 'stopped' }))
    const result = await engine.awaitPlan(started.runId)
    expect(result.done).toBe(true)
    expect(result).toMatchObject({ plan: { status: 'stopped' } })
  })

  it('stays stillRunning while the first auto plan awaits review, then resolves after approval', async () => {
    runTask.mockImplementation(async (request) => ({
      info: info(request.taskId),
      done: Promise.resolve({ result: 'Done', isError: false, status: 'succeeded' as const })
    }))
    const engine = new OrchestratorEngine({ profile: autoProfile() })
    engine.setGoal('Review then run')
    const started = engine.executePlanAsync(planInput('reviewed', 'Review then run'))
    await vi.waitFor(() => expect(engine.snapshot().pendingPlan?.planId).toBe(started.planId))

    vi.useFakeTimers()
    const waitingPromise = engine.awaitPlan(started.runId, 1_000)
    await vi.advanceTimersByTimeAsync(1_000)
    const waiting = await waitingPromise
    vi.useRealTimers()
    expect(waiting).toEqual(expect.objectContaining({ done: false, stillRunning: true, reason: 'timeout' }))
    expect(waiting).toMatchObject({ plan: { status: 'running' } })

    expect(engine.reviewPlan(true)).toBe(true)
    await vi.waitFor(() => expect(engine.getPlanRunStatus(started.runId)?.status).toBe('success'))
    const approved = await engine.awaitPlan(started.runId)
    expect(approved).toMatchObject({ done: true, plan: { status: 'success' } })
  })

  it('lets concurrent awaiters of a failing plan both resolve without an unhandled rejection', async () => {
    const finishOf = manualWorker()
    const engine = new OrchestratorEngine({ profile: autoProfile() })
    const started = engine.executePlanAsync(planInput('required', 'Failing plan'))
    await vi.waitFor(() => expect(engine.getPlanRunStatus(started.runId)?.tasks?.[0]?.status).toBe('running'))

    const rejections: unknown[] = []
    const onRejection = (reason: unknown): void => { rejections.push(reason) }
    process.on('unhandledRejection', onRejection)
    try {
      const a = engine.awaitPlan(started.runId)
      const b = engine.awaitPlan(started.runId)
      finishOf()({ result: 'Worker failed', isError: true, status: 'failed' })
      const [ra, rb] = await Promise.all([a, b])
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(ra).toMatchObject({ done: true, plan: { status: 'error' } })
      expect(rb).toMatchObject({ done: true, plan: { status: 'error' } })
      expect(rejections).toEqual([])
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  })
})
