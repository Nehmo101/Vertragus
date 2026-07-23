import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { OrchestratorSnapshot } from '@shared/orchestrator'
import { RemoteReadModel } from './readModel'
import { buildApnsPayload, diffPushTransitions, PushService, type PushServiceDependencies } from './pushService'
import type { StoredApnsToken, StoredPushSubscription } from './deviceStore'
import type { ApnsSender, ApnsSendResult, ApnsSendTarget } from './apnsSender'

function webPushDeps(): PushServiceDependencies {
  return {
    loadSubscriptions: () => [],
    saveSubscriptions: () => undefined,
    loadKeys: () => ({ publicKey: 'public', privateKey: 'private' }),
    saveKeys: vi.fn(),
    loadWebPush: async () => ({
      generateVAPIDKeys: vi.fn(), setVapidDetails: vi.fn(), sendNotification: vi.fn(async () => undefined)
    })
  }
}

function apnsToken(id: string, deviceId: string, token: string): StoredApnsToken {
  return { id, deviceId, token, environment: 'production', bundleId: 'com.example.App', createdAt: 1 }
}

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

describe('PushService APNs', () => {
  it('maps a transition to the APNs alert + data payload', () => {
    expect(buildApnsPayload({
      key: 'k', title: 'Titel', body: 'Text', url: '/#/live', profileId: 'p', workspaceSessionId: 's'
    })).toEqual({
      aps: { alert: { title: 'Titel', body: 'Text' }, sound: 'default' },
      url: '/#/live', profileId: 'p', workspaceSessionId: 's'
    })
  })

  it('registers and deduplicates APNs tokens by device token', () => {
    let tokens: StoredApnsToken[] = []
    const service = new PushService(new RemoteReadModel(new EventEmitter()), {
      ...webPushDeps(),
      loadApnsTokens: () => tokens,
      saveApnsTokens: (value) => { tokens = value }
    })
    service.subscribeApns('device-a', { token: 'a'.repeat(64), environment: 'production', bundleId: 'com.example.App' })
    service.subscribeApns('device-a', { token: 'b'.repeat(64), environment: 'sandbox', bundleId: 'com.example.App' })
    expect(tokens).toHaveLength(2)
    // Re-registering the same token replaces the prior entry rather than duplicating it.
    service.subscribeApns('device-a', { token: 'a'.repeat(64), environment: 'sandbox', bundleId: 'com.example.Other' })
    expect(tokens).toHaveLength(2)
    const replaced = tokens.find((entry) => entry.token === 'a'.repeat(64))!
    expect(replaced.environment).toBe('sandbox')
    expect(replaced.bundleId).toBe('com.example.Other')
  })

  it('prunes APNs tokens on removeDevice and removeAll', () => {
    let tokens: StoredApnsToken[] = [
      apnsToken('1', 'keep', 'a'.repeat(64)),
      apnsToken('2', 'drop', 'b'.repeat(64))
    ]
    const service = new PushService(new RemoteReadModel(new EventEmitter()), {
      ...webPushDeps(),
      loadApnsTokens: () => tokens,
      saveApnsTokens: (value) => { tokens = value }
    })
    service.removeDevice('drop')
    expect(tokens.map((entry) => entry.deviceId)).toEqual(['keep'])
    service.removeAll()
    expect(tokens).toEqual([])
  })

  it('delivers only inside the enrolled scope and prunes tokens APNs reports gone', async () => {
    const bus = new EventEmitter()
    const model = new RemoteReadModel(bus)
    model.start()
    let tokens: StoredApnsToken[] = [
      apnsToken('allowed', 'allowed-device', 'a'.repeat(64)),
      apnsToken('denied', 'denied-device', 'b'.repeat(64))
    ]
    const sends: Array<{ token: string; payload: unknown; target: ApnsSendTarget }> = []
    let result: ApnsSendResult = { status: 200 }
    const sender: ApnsSender = {
      send: async (token, payload, target) => { sends.push({ token, payload, target }); return result },
      close: () => undefined
    }
    const service = new PushService(
      model,
      {
        ...webPushDeps(),
        loadApnsTokens: () => tokens,
        saveApnsTokens: (value) => { tokens = value },
        loadApnsCredential: () => ({
          teamId: 'T', keyId: 'K', p8: 'x', bundleId: 'com.example.App', environment: 'production'
        }),
        loadApnsSender: async () => sender
      },
      (deviceId, profileId, sessionId) => deviceId === 'allowed-device' && profileId === 'p' && sessionId === 's'
    )
    service.start()
    bus.emit('snapshot', snapshot('running'))
    bus.emit('snapshot', snapshot('needs-work'))
    await vi.waitFor(() => expect(sends.length).toBeGreaterThanOrEqual(1))
    expect(sends.every((entry) => entry.token === 'a'.repeat(64))).toBe(true)
    expect(sends[0]!.target).toEqual({ environment: 'production', bundleId: 'com.example.App' })
    expect(sends[0]!.payload).toMatchObject({ aps: { sound: 'default' } })

    // A 400/BadDeviceToken response removes exactly the offending token, keeping the denied one.
    result = { status: 400, reason: 'BadDeviceToken' }
    bus.emit('snapshot', snapshot('running'))
    bus.emit('snapshot', snapshot('needs-work', 'Nutzungslimit erreicht'))
    await vi.waitFor(() => expect(tokens.map((entry) => entry.id)).toEqual(['denied']))
    service.stop()
    model.stop()
  })

  it('never touches APNs when no credential is configured', async () => {
    const bus = new EventEmitter()
    const model = new RemoteReadModel(bus)
    model.start()
    const sendNotification = vi.fn(async () => undefined)
    const loadApnsSender = vi.fn()
    let subs: StoredPushSubscription[] = [{
      id: 'sub', deviceId: 'allowed-device', endpoint: 'https://push.example/sub',
      keys: { p256dh: 'p', auth: 'a' }, createdAt: 1
    }]
    const service = new PushService(model, {
      ...webPushDeps(),
      loadSubscriptions: () => subs,
      saveSubscriptions: (value) => { subs = value },
      loadWebPush: async () => ({ generateVAPIDKeys: vi.fn(), setVapidDetails: vi.fn(), sendNotification }),
      loadApnsTokens: () => [apnsToken('t', 'allowed-device', 'a'.repeat(64))],
      saveApnsTokens: vi.fn(),
      loadApnsCredential: () => undefined,
      loadApnsSender
    })
    service.start()
    bus.emit('snapshot', snapshot('running'))
    bus.emit('snapshot', snapshot('needs-work'))
    // Web-Push delivered (so deliver() ran to completion incl. the APNs step), yet the
    // sender was never constructed because no credential is present.
    await vi.waitFor(() => expect(sendNotification).toHaveBeenCalled())
    expect(loadApnsSender).not.toHaveBeenCalled()
    service.stop()
    model.stop()
  })
})
