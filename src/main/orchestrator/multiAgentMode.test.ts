import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PROFILE, type AgentSlot, type WorkspaceProfile } from '@shared/profile'

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

const { runTask, kill } = vi.hoisted(() => ({
  runTask: vi.fn(),
  kill: vi.fn(async () => undefined)
}))
vi.mock('@main/agents/AgentManager', () => ({
  agentManager: { runTask, kill, list: () => [] }
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

interface Completion {
  result: string
  isError: boolean
  status: 'succeeded'
}

function info(taskId: string) {
  return {
    id: `agent-${taskId}`,
    name: `Agent ${taskId}`,
    provider: 'cursor' as const,
    model: 'grok',
    role: 'Task · grok',
    kind: 'sub' as const,
    mode: 'task' as const,
    taskId,
    yolo: false,
    workingDir: '.',
    worktree: `worktree-${taskId}`,
    status: 'running' as const,
    startedAt: Date.now()
  }
}

function multiProfile(
  count = 3,
  globalEnabled = true,
  slotOverride?: boolean
): WorkspaceProfile {
  const slot: AgentSlot = {
    ...DEFAULT_PROFILE.agents[0]!,
    role: 'grok',
    provider: 'cursor',
    model: 'grok',
    count,
    ...(slotOverride === undefined ? {} : { multiAgent: slotOverride })
  }
  return {
    ...DEFAULT_PROFILE,
    agents: [slot],
    multiAgent: { enabled: globalEnabled, stopLosers: true }
  }
}

function completeTasksImmediately(): void {
  runTask.mockImplementation(async (request: { taskId: string }) => ({
    info: info(request.taskId),
    done: Promise.resolve<Completion>({
      result: `ERGEBNIS: ERFOLG ${request.taskId}`,
      isError: false,
      status: 'succeeded'
    })
  }))
}

afterEach(() => {
  runTask.mockReset()
  kill.mockReset()
})

describe('profile Multiagent mode', () => {
  it('inherits an enabled global mode when the slot override is missing', async () => {
    completeTasksImmediately()
    const engine = new OrchestratorEngine({ profile: multiProfile(3, true) })

    engine.dispatchAsync('grok', 'Global aktiv', 'Geerbt an')

    await vi.waitFor(() => expect(runTask).toHaveBeenCalledTimes(3))
    expect(engine.listMultiAgentRuns()).toHaveLength(1)
    engine.dispose()
  })

  it('inherits a disabled global mode when the slot override is missing', async () => {
    completeTasksImmediately()
    const engine = new OrchestratorEngine({ profile: multiProfile(3, false) })

    await engine.dispatch('grok', 'Global inaktiv', 'Geerbt aus')

    expect(runTask).toHaveBeenCalledTimes(1)
    expect(engine.listMultiAgentRuns()).toEqual([])
    engine.dispose()
  })

  it('lets an explicit slot true override a disabled global mode', async () => {
    completeTasksImmediately()
    const engine = new OrchestratorEngine({ profile: multiProfile(3, false, true) })

    engine.dispatchAsync('grok', 'Slot aktiv', 'Override an')

    await vi.waitFor(() => expect(runTask).toHaveBeenCalledTimes(3))
    expect(engine.listMultiAgentRuns()).toHaveLength(1)
    engine.dispose()
  })

  it('lets an explicit slot false override an enabled global mode', async () => {
    completeTasksImmediately()
    const engine = new OrchestratorEngine({ profile: multiProfile(3, true, false) })

    await engine.dispatch('grok', 'Slot inaktiv', 'Override aus')

    expect(runTask).toHaveBeenCalledTimes(1)
    expect(engine.listMultiAgentRuns()).toEqual([])
    engine.dispose()
  })

  it('does not fan out when the enabled target slot has count one', async () => {
    completeTasksImmediately()
    const engine = new OrchestratorEngine({ profile: multiProfile(1, true, true) })

    await engine.dispatch('grok', 'Ein Worker', 'Count eins')

    expect(runTask).toHaveBeenCalledTimes(1)
    expect(engine.listMultiAgentRuns()).toEqual([])
    engine.dispose()
  })

  it('does not recursively fan out a dispatch marked as a multiagent candidate', async () => {
    completeTasksImmediately()
    const engine = new OrchestratorEngine({ profile: multiProfile(3, true, true) })

    await engine.dispatch('grok', 'Kandidat', 'Rekursionsschutz', {
      multiAgentRunId: 'multi-existing'
    })

    expect(runTask).toHaveBeenCalledTimes(1)
    expect(engine.listMultiAgentRuns()).toEqual([])
    engine.dispose()
  })

  it('evaluates the actually addressed slot when multiple slots are configured', async () => {
    completeTasksImmediately()
    const directSlot: AgentSlot = {
      ...DEFAULT_PROFILE.agents[0]!,
      role: 'direct',
      provider: 'cursor',
      model: 'direct-model',
      count: 4,
      multiAgent: false
    }
    const fanoutSlot: AgentSlot = {
      ...DEFAULT_PROFILE.agents[0]!,
      role: 'fanout',
      provider: 'cursor',
      model: 'fanout-model',
      count: 2,
      multiAgent: true
    }
    const profile: WorkspaceProfile = {
      ...DEFAULT_PROFILE,
      agents: [directSlot, fanoutSlot],
      multiAgent: { enabled: false, stopLosers: true }
    }
    const engine = new OrchestratorEngine({ profile })

    await engine.dispatch('direct', 'Direkt', 'Adressiertes Slot-Aus')
    engine.dispatchAsync('fanout', 'Parallel', 'Adressiertes Slot-An')

    await vi.waitFor(() => expect(runTask).toHaveBeenCalledTimes(3))
    expect(runTask.mock.calls.map(([request]) => request.model)).toEqual([
      'direct-model',
      'fanout-model',
      'fanout-model'
    ])
    expect(engine.listMultiAgentRuns()).toEqual([
      expect.objectContaining({ role: 'fanout', candidateTaskIds: expect.any(Array) })
    ])
    expect(engine.listMultiAgentRuns()[0]?.candidateTaskIds).toHaveLength(2)
    engine.dispose()
  })

  it('fans one task out to the slot count and integrates only the reviewed winner', async () => {
    const completions = new Map<string, (value: Completion) => void>()
    runTask.mockImplementation(async (request: { taskId: string }) => ({
      info: info(request.taskId),
      done: new Promise<Completion>((resolve) => completions.set(request.taskId, resolve))
    }))
    const engine = new OrchestratorEngine({ profile: multiProfile(3) })

    const parent = engine.dispatchAsync('grok', 'Implementiere die API.', 'API')
    await vi.waitFor(() => expect(runTask).toHaveBeenCalledTimes(3))

    const candidates = engine.listMultiAgentRuns()[0]
    expect(candidates).toEqual(expect.objectContaining({
      parentTaskId: parent.taskId,
      status: 'running',
      candidateTaskIds: [
        `${parent.taskId}-m1`,
        `${parent.taskId}-m2`,
        `${parent.taskId}-m3`
      ]
    }))
    for (const taskId of candidates!.candidateTaskIds) {
      completions.get(taskId)?.({
        result: `ERGEBNIS: ERFOLG ${taskId}`,
        isError: false,
        status: 'succeeded'
      })
    }

    await vi.waitFor(() =>
      expect(engine.listMultiAgentRuns()[0]?.status).toBe('awaiting-review')
    )
    expect(engine.getTaskStatus(parent.taskId)?.status).toBe('waiting')

    const winnerId = candidates!.candidateTaskIds[1]!
    await engine.reviewMultiAgentRun({
      runId: candidates!.id,
      action: 'accept',
      candidateTaskId: winnerId,
      feedback: 'Kandidat 2 hat die vollständigste Lösung und grüne Tests.'
    })

    await vi.waitFor(() => expect(engine.getTaskStatus(parent.taskId)?.status).toBe('success'))
    expect(engine.listMultiAgentRuns()[0]).toEqual(expect.objectContaining({
      status: 'accepted',
      winnerTaskId: winnerId
    }))
    expect(engine.getTaskStatus(parent.taskId)).toEqual(expect.objectContaining({
      agentName: `Agent ${winnerId}`,
      result: expect.stringContaining('Kandidat 2')
    }))
    expect(kill).not.toHaveBeenCalled()
    engine.dispose()
  })

  it('delivers a direct support response back to a waiting subagent', async () => {
    let finish!: (value: Completion) => void
    runTask.mockImplementationOnce(async (request: { taskId: string }) => ({
      info: info(request.taskId),
      done: new Promise<Completion>((resolve) => { finish = resolve })
    }))
    const profile = {
      ...multiProfile(1),
      multiAgent: { enabled: false, stopLosers: true }
    }
    const engine = new OrchestratorEngine({ profile })
    const task = engine.dispatchAsync('grok', 'Klärungsbedürftige Aufgabe', 'Frage')
    await vi.waitFor(() => expect(runTask).toHaveBeenCalledTimes(1))

    const request = engine.requestSubagentSupport(task.taskId, {
      question: 'Soll die bestehende API abwärtskompatibel bleiben?',
      context: 'Die Signatur wird sonst schmaler.'
    })
    const waiting = engine.awaitSubagentSupportResponse(request.id, 5_000)
    await engine.respondSubagentSupport(
      request.id,
      'Ja, bestehende Aufrufer müssen unverändert funktionieren.',
      'continue'
    )

    await expect(waiting).resolves.toEqual(expect.objectContaining({
      done: true,
      request: expect.objectContaining({
        status: 'answered',
        response: expect.stringContaining('bestehende Aufrufer')
      })
    }))
    expect(engine.snapshot().subagentRequests).toEqual([
      expect.objectContaining({ id: request.id, status: 'answered' })
    ])

    finish({ result: 'ERGEBNIS: ERFOLG', isError: false, status: 'succeeded' })
    await vi.waitFor(() => expect(engine.getTaskStatus(task.taskId)?.status).toBe('success'))
    engine.dispose()
  })
})
