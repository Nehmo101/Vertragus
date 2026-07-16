import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PROFILE, type WorkspaceProfile } from '@shared/profile'

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

function multiProfile(count = 3): WorkspaceProfile {
  return {
    ...DEFAULT_PROFILE,
    agents: [{
      ...DEFAULT_PROFILE.agents[0]!,
      role: 'grok',
      provider: 'cursor',
      model: 'grok',
      count
    }],
    multiAgent: { enabled: true, stopLosers: true }
  }
}

afterEach(() => {
  runTask.mockReset()
  kill.mockReset()
})

describe('profile Multiagent mode', () => {
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
