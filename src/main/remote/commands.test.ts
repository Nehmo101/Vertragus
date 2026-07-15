import { describe, expect, it, vi } from 'vitest'
import type { DeviceInfo } from '@shared/remote'
import { REMOTE_COMMAND_IDS } from '@shared/remote'
import { RemoteCommandRouter } from './commands'

const steerDevice: DeviceInfo = {
  id: 'device-1', name: 'Phone', capabilities: ['read', 'steer'],
  actor: { id: 'owner', displayName: 'Owner' },
  scopes: [{ profileId: 'p', sessionIds: ['s'], allowGoalSubmit: true }],
  createdAt: 1
}

function router(): RemoteCommandRouter {
  return new RemoteCommandRouter({
    reviewPlan: vi.fn(() => true),
    enableAutoMode: vi.fn(() => true),
    reset: vi.fn(),
    submitGoal: vi.fn(() => ({ submitted: true })),
    approvePublication: vi.fn(() => true),
    rejectPublication: vi.fn(() => true),
    taskDiff: vi.fn(() => ({ taskId: 'task', diff: 'safe', truncated: false })),
    resolvePermission: vi.fn(() => true),
    setBudgetCaps: vi.fn(() => ({ tokens: 0, costUsd: 0, caps: {}, exceeded: false })),
    pauseTask: vi.fn(() => true),
    resumeTask: vi.fn(() => true),
    fallbackTask: vi.fn(() => true),
    replanPending: vi.fn(() => true),
    activateKillSwitch: vi.fn()
  })
}

describe('RemoteCommandRouter', () => {
  it('contains exactly the Phase-A whitelist and no dangerous regression routes', () => {
    const value = router()
    expect(value.ids().sort()).toEqual([...REMOTE_COMMAND_IDS].sort())
    for (const denied of ['agent.write', 'spawn', 'agent.spawn', 'config.set', 'config:set', 'secrets.get']) {
      expect(value.resolve(denied)).toBeUndefined()
    }
  })

  it('returns 404 for unknown commands and rejects malformed extra arguments', async () => {
    const value = router()
    await expect(value.execute({ id: 'agent.write', args: {} }, steerDevice))
      .rejects.toMatchObject({ status: 404 })
    await expect(value.execute({
      id: 'plan.approve', args: { profileId: 'p', sessionId: 's', command: 'rm -rf .' }
    }, steerDevice)).rejects.toMatchObject({ status: 400 })
  })

  it('capability-gates admin commands', async () => {
    await expect(router().execute({
      id: 'run.reset', args: { profileId: 'p', sessionId: 's' }
    }, steerDevice)).rejects.toMatchObject({ status: 403 })
  })

  it('keeps task.diff behind its own default-off capability', async () => {
    await expect(router().execute({
      id: 'task.diff', args: { profileId: 'p', sessionId: 's', taskId: 'task' }
    }, steerDevice)).rejects.toMatchObject({ status: 403 })
    await expect(router().execute({
      id: 'task.diff', args: { profileId: 'p', sessionId: 's', taskId: 'task' }
    }, { ...steerDevice, capabilities: [...steerDevice.capabilities, 'diff'] }))
      .resolves.toMatchObject({ taskId: 'task' })
  })

  it('keeps C capabilities default-off and enforces exact workspace scopes', async () => {
    await expect(router().execute({
      id: 'permission.allow', args: { profileId: 'p', sessionId: 's', permissionId: '00000000-0000-4000-8000-000000000000' }
    }, steerDevice)).rejects.toMatchObject({ status: 403 })
    await expect(router().execute({
      id: 'plan.approve', args: { profileId: 'p', sessionId: 'other' }
    }, steerDevice)).rejects.toMatchObject({ status: 403, code: 'scope_forbidden' })
  })

  it('keeps provider fallback behind its own Phase-D capability', async () => {
    const envelope = { id: 'task.fallback', args: { profileId: 'p', sessionId: 's', taskId: 'task' } }
    await expect(router().execute(envelope, steerDevice)).rejects.toMatchObject({ status: 403 })
    await expect(router().execute(envelope, {
      ...steerDevice,
      capabilities: [...steerDevice.capabilities, 'provider-fallback']
    })).resolves.toEqual({ fallback: true })
  })
})
