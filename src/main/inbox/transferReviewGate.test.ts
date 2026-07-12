import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_PROFILE } from '@shared/profile'

vi.mock('electron', () => ({
  app: { getPath: () => '.', getName: () => 'test', isPackaged: false },
  BrowserWindow: class {},
  shell: { openExternal: vi.fn() }
}))

vi.mock('@main/windows', () => ({
  createPaneWindow: vi.fn(),
  broadcast: vi.fn()
}))

vi.mock('@main/config/store', () => ({
  getProfile: () => DEFAULT_PROFILE,
  getActiveProfileId: () => 'default',
  getSetting: () => undefined,
  setSetting: vi.fn()
}))

vi.mock('@main/agents/AgentManager', () => ({
  agentManager: {
    runTask: vi.fn()
  }
}))

import { OrchestratorEngine } from '@main/orchestrator/Engine'

describe('transfer review gate', () => {
  it('executePlan in review mode blocks task dispatch until approval', async () => {
    const engine = new OrchestratorEngine()
    engine.activate()

    const planInput = {
      version: 1,
      goal: 'Inbox idea goal',
      maxParallel: 2,
      tasks: [
        {
          id: 't1',
          title: 'Implement',
          role: 'codex',
          prompt: 'Do work',
          dependsOn: [] as string[],
          conflictKeys: [] as string[]
        }
      ]
    }

    const reviewPromise = engine.executePlan(planInput)

    await new Promise((r) => setTimeout(r, 10))
    const snap = engine.snapshot()
    expect(snap.pendingPlan).toBeDefined()
    expect(snap.pendingPlan?.planId).toBeTruthy()
    expect(snap.tasks.filter((t) => t.status === 'running')).toHaveLength(0)

    engine.reviewPlan(false)
    const result = await reviewPromise
    expect(result.tasks[0]?.status).toBe('stopped')
  })
})
