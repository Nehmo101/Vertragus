import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { OrchestratorSnapshot, OrcaTask } from '@shared/orchestrator'
import type { RemoteEventFrame } from '@shared/remote'
import {
  readPushSubscriptions,
  readVapidKeys,
  writePushSubscriptions,
  writeVapidKeys,
  type StoredPushSubscription,
  type StoredVapidKeys
} from './deviceStore'
import type { RemoteReadModel } from './readModel'

export interface PushTransition {
  key: string
  title: string
  body: string
  url: string
  profileId?: string
  workspaceSessionId?: string
}

function taskMap(snapshot: OrchestratorSnapshot | undefined): Map<string, OrcaTask> {
  return new Map((snapshot?.tasks ?? []).map((task) => [task.id, task]))
}

function isActive(task: OrcaTask): boolean {
  return task.status === 'queued' || task.status === 'running' || task.status === 'waiting' || task.status === 'paused'
}
function isTerminal(task: OrcaTask): boolean { return !isActive(task) }

/** Pure transition diff. Identical heartbeat snapshots produce no notifications. */
export function diffPushTransitions(
  previous: OrchestratorSnapshot | undefined,
  current: OrchestratorSnapshot
): PushTransition[] {
  if (!previous) return []
  const output: PushTransition[] = []
  const scope = current.workspaceSessionId ?? current.profileId ?? 'workspace'
  const scoped = { profileId: current.profileId, workspaceSessionId: current.workspaceSessionId }
  const before = taskMap(previous)
  if (current.pendingPlan && previous.pendingPlan?.planId !== current.pendingPlan.planId) {
    output.push({
      key: `plan:${scope}:${current.pendingPlan.planId}`,
      title: 'Plan wartet auf Freigabe',
      body: `${current.pendingPlan.plan.tasks.length} Aufgabe(n) für ${current.pendingPlan.plan.goal}`,
      url: '/#/approvals',
      ...scoped
    })
  }
  for (const task of current.tasks) {
    const prior = before.get(task.id)
    if ((task.status === 'needs-work' || task.status === 'error') && prior?.status !== task.status) {
      output.push({
        key: `blocked:${scope}:${task.id}:${task.status}`,
        title: 'Task benötigt Aufmerksamkeit',
        body: task.blocker?.summary ?? task.note ?? task.title,
        url: '/#/approvals',
        ...scoped
      })
    }
    if (task.prUrl && task.prUrl !== prior?.prUrl) {
      output.push({
        key: `pr:${scope}:${task.id}:${task.prUrl}`,
        title: 'Pull Request geöffnet',
        body: task.title,
        url: '/#/live',
        ...scoped
      })
    }
    const limitNow = /(?:nutzungslimit|rate.?limit|quota|5-stunden-limit|wochenlimit)/i.test(task.note ?? '')
    const limitBefore = /(?:nutzungslimit|rate.?limit|quota|5-stunden-limit|wochenlimit)/i.test(prior?.note ?? '')
    if (limitNow && !limitBefore) {
      output.push({
        key: `limit:${scope}:${task.id}`,
        title: 'Provider-Nutzungslimit',
        body: task.note ?? task.title,
        url: '/#/live',
        ...scoped
      })
    }
  }
  const wasRunning = previous.tasks.some(isActive)
  const finished = current.tasks.length > 0 && current.tasks.every(isTerminal)
  if (wasRunning && finished) {
    output.push({
      key: `finished:${scope}:${current.tasks.map((task) => `${task.id}:${task.status}`).join(',')}`,
      title: 'Vertragus-Lauf beendet',
      body: current.goal?.title ?? 'Alle Aufgaben sind terminal.',
      url: '/#/live',
      ...scoped
    })
  }
  return output
}

interface WebPushModule {
  generateVAPIDKeys(): StoredVapidKeys
  setVapidDetails(subject: string, publicKey: string, privateKey: string): void
  sendNotification(
    subscription: Omit<StoredPushSubscription, 'id' | 'deviceId' | 'createdAt'>,
    payload: string,
    options: { TTL: number; urgency: 'normal' }
  ): Promise<unknown>
}

export interface PushServiceDependencies {
  loadSubscriptions(): StoredPushSubscription[]
  saveSubscriptions(value: StoredPushSubscription[]): void
  loadKeys(): StoredVapidKeys | undefined
  saveKeys(value: StoredVapidKeys): void
  loadWebPush(): Promise<WebPushModule>
  onDelivery?(transition: PushTransition, outcome: 'sent' | 'gone' | 'error'): void
}

const defaults: PushServiceDependencies = {
  loadSubscriptions: readPushSubscriptions,
  saveSubscriptions: writePushSubscriptions,
  loadKeys: readVapidKeys,
  saveKeys: writeVapidKeys,
  loadWebPush: async () => import('web-push'),
  onDelivery: undefined
}

export class PushService extends EventEmitter {
  private unsubscribe: (() => void) | undefined
  private readonly snapshots = new Map<string, OrchestratorSnapshot>()
  private readonly delivered = new Set<string>()

  constructor(
    private readonly readModel: RemoteReadModel,
    private readonly dependencies: PushServiceDependencies = defaults,
    private readonly canRead: (deviceId: string, profileId?: string, sessionId?: string) => boolean = () => true
  ) { super() }

  start(): void {
    if (this.unsubscribe) return
    this.unsubscribe = this.readModel.subscribe((frame) => this.onFrame(frame))
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.snapshots.clear()
    this.delivered.clear()
  }

  private onFrame(frame: RemoteEventFrame): void {
    if (frame.type !== 'snapshot') return
    const key = frame.snapshot.workspaceSessionId ?? frame.snapshot.profileId
    if (!key) return
    const previous = this.snapshots.get(key)
    this.snapshots.set(key, frame.snapshot)
    for (const transition of diffPushTransitions(previous, frame.snapshot)) {
      if (this.delivered.has(transition.key)) continue
      this.delivered.add(transition.key)
      void this.deliver(transition)
    }
  }

  async publicKey(): Promise<string> { return (await this.ensureKeys()).publicKey }

  subscribe(deviceId: string, input: Omit<StoredPushSubscription, 'id' | 'deviceId' | 'createdAt'>): void {
    const subscriptions = this.dependencies.loadSubscriptions()
      .filter((subscription) => subscription.endpoint !== input.endpoint)
    subscriptions.push({ ...input, id: randomUUID(), deviceId, createdAt: Date.now() })
    this.dependencies.saveSubscriptions(subscriptions)
  }

  removeDevice(deviceId: string): void {
    this.dependencies.saveSubscriptions(
      this.dependencies.loadSubscriptions().filter((subscription) => subscription.deviceId !== deviceId)
    )
  }

  removeAll(): void { this.dependencies.saveSubscriptions([]) }

  private async ensureKeys(): Promise<StoredVapidKeys> {
    const existing = this.dependencies.loadKeys()
    if (existing) return existing
    const webPush = await this.dependencies.loadWebPush()
    const generated = webPush.generateVAPIDKeys()
    this.dependencies.saveKeys(generated)
    return generated
  }

  private async deliver(transition: PushTransition): Promise<void> {
    const allSubscriptions = this.dependencies.loadSubscriptions()
    const subscriptions = allSubscriptions.filter((subscription) =>
      this.canRead(subscription.deviceId, transition.profileId, transition.workspaceSessionId)
    )
    if (subscriptions.length === 0) return
    const keys = await this.ensureKeys()
    const webPush = await this.dependencies.loadWebPush()
    webPush.setVapidDetails('mailto:orca@localhost.invalid', keys.publicKey, keys.privateKey)
    const gone = new Set<string>()
    await Promise.all(subscriptions.map(async (subscription) => {
      try {
        await webPush.sendNotification(
          {
            endpoint: subscription.endpoint,
            expirationTime: subscription.expirationTime,
            keys: subscription.keys
          },
          JSON.stringify(transition),
          { TTL: 60 * 60, urgency: 'normal' }
        )
        this.dependencies.onDelivery?.(transition, 'sent')
        this.emit('delivery', transition, 'sent')
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode
        if (status === 404 || status === 410) {
          gone.add(subscription.id)
          this.dependencies.onDelivery?.(transition, 'gone')
          this.emit('delivery', transition, 'gone')
        } else {
          this.dependencies.onDelivery?.(transition, 'error')
          this.emit('delivery', transition, 'error')
        }
      }
    }))
    if (gone.size > 0) {
      this.dependencies.saveSubscriptions(allSubscriptions.filter((subscription) => !gone.has(subscription.id)))
    }
  }
}
