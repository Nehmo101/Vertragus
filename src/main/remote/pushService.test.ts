import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { OrchestratorSnapshot } from '@shared/orchestrator'
import { RemoteReadModel } from './readModel'
import { diffPushTransitions, PushService, type PushServiceDependencies } from './pushService'
import type { StoredPushSubscription } from './deviceStore'

function snapshot(status: 'running' | 'needs-work' | 'success', note?: string): OrchestratorSnapshot {
  return {
    profileId: 'p', workspaceSessionId: 's', goal: { id: 'g', title: 'Goal', active: true },
    tasks: [{ id: 't', title: 'Task', role: 'worker', status, note, createdAt: 1 }]
  }
}

describe('PushService transitions', () => {
  it('diffs transitions and emits no heartbeat duplicates', () => {
    const running = snapshot('running')
    const blocked = snapshot('needs-work', 'Nutzungslimit erreicht')
    expect(diffPushTransitions(undefined, running)).toEqual([])
    expect(diffPushTransitions(running, running)).toEqual([])
    expect(diffPushTransitions(running, blocked).map((item) => item.key)).toEqual([
      'blocked:s:t:needs-work', 'limit:s:t', 'finished:s:t:needs-work'
    ])
    expect(diffPushTransitions(blocked, blocked)).toEqual([])
  })

  it('deduplicates delivery and removes 410 Gone subscriptions', async () => {
    const bus = new EventEmitter()
    const model = new RemoteReadModel(bus)
    model.start()
    let subscriptions: StoredPushSubscription[] = [{
      id: 'sub', deviceId: 'device', endpoint: 'https://push.example/sub',
      keys: { p256dh: 'p', auth: 'a' }, createdAt: 1
    }]
    const sendNotification = vi.fn(async () => { throw Object.assign(new Error('gone'), { statusCode: 410 }) })
    const dependencies: PushServiceDependencies = {
      loadSubscriptions: () => subscriptions,
      saveSubscriptions: (value) => { subscriptions = value },
      loadKeys: () => ({ publicKey: 'public', privateKey: 'private' }),
      saveKeys: vi.fn(),
      loadWebPush: async () => ({ generateVAPIDKeys: vi.fn(), setVapidDetails: vi.fn(), sendNotification })
    }
    const service = new PushService(model, dependencies)
    service.start()
    bus.emit('snapshot', snapshot('running'))
    bus.emit('snapshot', snapshot('needs-work'))
    await vi.waitFor(() => expect(sendNotification).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(subscriptions).toEqual([]))
    bus.emit('snapshot', snapshot('needs-work'))
    expect(sendNotification).toHaveBeenCalledTimes(2)
    service.stop()
    model.stop()
  })

  it('delivers only inside the enrolled device scope without deleting denied subscriptions', async () => {
    const bus = new EventEmitter()
    const model = new RemoteReadModel(bus)
    model.start()
    let subscriptions: StoredPushSubscription[] = [
      {
        id: 'allowed', deviceId: 'allowed-device', endpoint: 'https://push.example/allowed',
        keys: { p256dh: 'p', auth: 'a' }, createdAt: 1
      },
      {
        id: 'denied', deviceId: 'denied-device', endpoint: 'https://push.example/denied',
        keys: { p256dh: 'p', auth: 'a' }, createdAt: 1
      }
    ]
    const sendNotification = vi.fn(async (
      _subscription: { endpoint: string },
      _payload: string,
      _options: { TTL: number; urgency: 'normal' }
    ) => undefined)
    const dependencies: PushServiceDependencies = {
      loadSubscriptions: () => subscriptions,
      saveSubscriptions: (value) => { subscriptions = value },
      loadKeys: () => ({ publicKey: 'public', privateKey: 'private' }),
      saveKeys: vi.fn(),
      loadWebPush: async () => ({ generateVAPIDKeys: vi.fn(), setVapidDetails: vi.fn(), sendNotification })
    }
    const service = new PushService(
      model,
      dependencies,
      (deviceId, profileId, sessionId) => deviceId === 'allowed-device' && profileId === 'p' && sessionId === 's'
    )
    service.start()
    bus.emit('snapshot', snapshot('running'))
    bus.emit('snapshot', snapshot('needs-work'))
    await vi.waitFor(() => expect(sendNotification).toHaveBeenCalledTimes(2))
    expect(sendNotification.mock.calls.every(([subscription]) =>
      subscription.endpoint === 'https://push.example/allowed'
    )).toBe(true)
    expect(subscriptions.map((subscription) => subscription.id)).toEqual(['allowed', 'denied'])
    service.stop()
    model.stop()
  })
})
