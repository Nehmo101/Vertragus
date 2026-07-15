import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PROFILE } from '@shared/profile'
import { permissionBroker } from '@main/permissions/PermissionBroker'
import { OrchestratorEngine } from './Engine'

vi.mock('electron', () => ({
  app: { getPath: () => '.', getName: () => 'test', isPackaged: false },
  BrowserWindow: class {},
  shell: { openExternal: vi.fn() }
}))
vi.mock('@main/windows', () => ({ createPaneWindow: vi.fn(), broadcast: vi.fn() }))
vi.mock('@main/config/store', () => ({
  getProfile: () => undefined,
  getActiveProfileId: () => 'default',
  getSetting: () => undefined,
  setSetting: vi.fn()
}))

const engines: OrchestratorEngine[] = []
afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose()
})

describe('OrchestratorEngine remote primitives', () => {
  it('projects and resolves only broker requests owned by this engine', () => {
    const engine = new OrchestratorEngine({ profile: DEFAULT_PROFILE, workspaceSessionId: 'scope-1' })
    engines.push(engine)
    const respond = vi.fn()
    const request = permissionBroker.requestFromProviderCallback({
      provider: 'claude', agentId: 'agent-1', engineId: engine.engineId,
      profileId: DEFAULT_PROFILE.id, workspaceSessionId: 'scope-1', yolo: false
    }, 'Bash', respond)!
    expect(engine.snapshot().pendingPermissions).toEqual([expect.objectContaining({ id: request.id })])
    expect(engine.resolvePermission(request.id, false)).toBe(true)
    expect(respond).toHaveBeenCalledWith('n\r')
    expect(engine.snapshot().pendingPermissions).toEqual([])
  })

  it('updates a pending plan preview without accepting new commands or paths', async () => {
    const engine = new OrchestratorEngine({ profile: DEFAULT_PROFILE, workspaceSessionId: 'scope-2' })
    engines.push(engine)
    engine.executePlanAsync({
      version: 1, goal: 'Preview', maxParallel: 2,
      tasks: [
        { id: 'keep', title: 'Keep', role: 'codex', prompt: 'a', dependsOn: [], conflictKeys: [] },
        { id: 'remove', title: 'Remove', role: 'codex', prompt: 'b', dependsOn: [], conflictKeys: [] }
      ]
    })
    await vi.waitFor(() => expect(engine.snapshot().pendingPlan).toBeDefined())
    expect(engine.replanPending({ removeTaskIds: ['remove'], maxParallel: 1 })).toBe(true)
    expect(engine.snapshot().pendingPlan?.plan).toMatchObject({
      maxParallel: 1,
      tasks: [expect.objectContaining({ id: 'keep' })]
    })
    expect(engine.reviewPlan(false)).toBe(true)
  })

  it('exposes aggregate caps with a restrictive exceeded state', () => {
    const engine = new OrchestratorEngine({ profile: DEFAULT_PROFILE, workspaceSessionId: 'scope-3' })
    engines.push(engine)
    expect(engine.setBudgetCaps({ maxTokens: 1_000 })).toMatchObject({
      caps: { maxTokens: 1_000 }, exceeded: false
    })
  })
})
