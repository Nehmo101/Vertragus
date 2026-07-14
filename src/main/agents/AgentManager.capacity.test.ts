import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '.' }
}))
vi.mock('@main/windows', () => ({ closePaneWindows: vi.fn(), createPaneWindow: vi.fn() }))

const limits = vi.hoisted(() => ({ codex: 1 as number }))
vi.mock('@main/config/store', () => ({
  getSetting: (key: string) => (key === 'providerLimits' ? { codex: limits.codex } : undefined),
  getProfile: () => undefined,
  listMcpServers: () => []
}))
vi.mock('@main/agents/worktree', () => ({
  createWorktree: vi.fn(async () => null),
  currentBranch: vi.fn(async () => 'main'),
  rollbackWorktree: vi.fn(async () => false)
}))
vi.mock('@main/agents/resolveCommand', () => ({
  resolveLaunch: vi.fn(async () => {
    throw new Error('CLI nicht installiert')
  })
}))

const runHeadless = vi.hoisted(() => vi.fn())
vi.mock('@main/agents/headless', () => ({ runHeadless }))

import type { PanePreflightReport } from '@shared/orchestrator'
import type { HeadlessResult } from '@main/agents/headless'
import { AgentManager, type RunTaskRequest } from '@main/agents/AgentManager'
import { providerCapacity } from '@main/agents/providerCapacity'

const passingPreflight = async (input: { provider: string }): Promise<PanePreflightReport> => ({
  status: 'passed',
  provider: input.provider as PanePreflightReport['provider'],
  workspaceId: 'test',
  startedAt: Date.now(),
  completedAt: Date.now(),
  checks: []
})

function taskRequest(taskId: string): RunTaskRequest {
  return {
    provider: 'codex',
    model: '',
    role: 'worker',
    taskId,
    prompt: 'Arbeite.',
    yolo: false,
    workingDir: '.'
  }
}

function controllableHeadless(): Array<(result: HeadlessResult) => void> {
  const resolvers: Array<(result: HeadlessResult) => void> = []
  runHeadless.mockReset()
  runHeadless.mockImplementation(() => ({
    pid: 1,
    done: new Promise<HeadlessResult>((resolve) => resolvers.push(resolve)),
    kill: vi.fn()
  }))
  return resolvers
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('provider capacity gate for headless tasks', () => {
  it('queues the second task at the gate and releases the slot when a run finishes', async () => {
    limits.codex = 1
    providerCapacity.refreshLimits()
    const manager = new AgentManager(passingPreflight)
    const resolvers = controllableHeadless()

    const first = await manager.runTask(taskRequest('t1'))
    expect(runHeadless).toHaveBeenCalledTimes(1)
    expect(providerCapacity.stats('codex').active).toBe(1)

    const secondPromise = manager.runTask(taskRequest('t2'))
    await settle()
    // Still gated: no second provider process, one agent visibly waiting.
    expect(runHeadless).toHaveBeenCalledTimes(1)
    expect(manager.list().some((agent) => agent.status === 'waiting')).toBe(true)
    expect(providerCapacity.stats('codex').waiting).toBe(1)

    resolvers[0]!({ result: 'fertig', isError: false, status: 'succeeded' })
    await first.done
    const second = await secondPromise
    await vi.waitFor(() => expect(runHeadless).toHaveBeenCalledTimes(2))
    expect(providerCapacity.stats('codex').active).toBe(1)

    resolvers[1]!({ result: 'fertig', isError: false, status: 'succeeded' })
    await second.done
    expect(providerCapacity.stats('codex').active).toBe(0)
  })

  it('kill during the gate wait resolves the queued task as cancelled without leaking a slot', async () => {
    limits.codex = 1
    providerCapacity.refreshLimits()
    const manager = new AgentManager(passingPreflight)
    const resolvers = controllableHeadless()

    const first = await manager.runTask(taskRequest('t1'))
    const secondPromise = manager.runTask(taskRequest('t2'))
    await settle()
    const waiting = manager.list().find((agent) => agent.status === 'waiting')
    expect(waiting).toBeDefined()

    await manager.kill(waiting!.id)
    const second = await secondPromise
    const result = await second.done
    expect(result.status).toBe('cancelled')
    expect(runHeadless).toHaveBeenCalledTimes(1)

    resolvers[0]!({ result: 'fertig', isError: false, status: 'succeeded' })
    await first.done
    await settle()
    expect(providerCapacity.stats('codex').active).toBe(0)
    expect(providerCapacity.stats('codex').waiting).toBe(0)
  })

  it('spawn releases the held provider slot when launch preparation throws', async () => {
    limits.codex = 1
    providerCapacity.refreshLimits()
    const manager = new AgentManager(passingPreflight)

    await expect(
      manager.spawn({ provider: 'codex', model: '', kind: 'sub' })
    ).rejects.toThrowError('CLI nicht installiert')
    expect(providerCapacity.stats('codex').active).toBe(0)

    // The slot must be usable again immediately.
    const resolvers = controllableHeadless()
    const task = await manager.runTask(taskRequest('t3'))
    expect(runHeadless).toHaveBeenCalledTimes(1)
    resolvers[0]!({ result: 'fertig', isError: false, status: 'succeeded' })
    await task.done
    expect(providerCapacity.stats('codex').active).toBe(0)
  })
})
