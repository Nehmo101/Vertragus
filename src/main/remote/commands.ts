import { z } from 'zod'
import type { DeviceInfo, RemoteCapability, RemoteCommandEnvelope, RemoteCommandId } from '@shared/remote'
import { TokenBucketRateLimiter } from './rateLimit'

export class RemoteCommandError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message)
  }
}

export interface RemoteCommandDependencies {
  reviewPlan(profileId: string, approved: boolean, sessionId: string): boolean | Promise<boolean>
  enableAutoMode(profileId: string, sessionId: string): boolean | Promise<boolean>
  reset(profileId: string, sessionId: string): void | Promise<void>
  submitGoal(profileId: string, text: string): unknown | Promise<unknown>
  activateKillSwitch(): void | Promise<void>
}

interface RemoteCommandRoute<T = unknown> {
  id: RemoteCommandId
  capability: RemoteCapability
  schema: z.ZodType<T>
  handle(args: T): unknown | Promise<unknown>
}

const scopeSchema = z.object({
  profileId: z.string().trim().min(1).max(128),
  sessionId: z.string().trim().min(1).max(128)
}).strict()

const goalSchema = z.object({
  profileId: z.string().trim().min(1).max(128),
  text: z.string().trim().min(1).max(8_000)
}).strict()

const emptySchema = z.object({}).strict()

export class RemoteCommandRouter {
  private readonly routes = new Map<RemoteCommandId, RemoteCommandRoute>()
  private readonly goalLimiter: TokenBucketRateLimiter

  constructor(dependencies: RemoteCommandDependencies, now: () => number = Date.now) {
    this.goalLimiter = new TokenBucketRateLimiter({
      capacity: 3,
      refillTokens: 3,
      refillIntervalMs: 60 * 60_000,
      now
    })
    this.register({
      id: 'plan.approve', capability: 'steer', schema: scopeSchema,
      handle: async (args) => ({ resolved: await dependencies.reviewPlan(args.profileId, true, args.sessionId) })
    })
    this.register({
      id: 'plan.reject', capability: 'steer', schema: scopeSchema,
      handle: async (args) => ({ resolved: await dependencies.reviewPlan(args.profileId, false, args.sessionId) })
    })
    this.register({
      id: 'mode.enableAuto', capability: 'steer', schema: scopeSchema,
      handle: async (args) => ({ enabled: await dependencies.enableAutoMode(args.profileId, args.sessionId) })
    })
    this.register({
      id: 'run.reset', capability: 'admin', schema: scopeSchema,
      handle: async (args) => {
        await dependencies.reset(args.profileId, args.sessionId)
        return { reset: true }
      }
    })
    this.register({
      id: 'goal.submit', capability: 'steer', schema: goalSchema,
      handle: async (args) => {
        if (!this.goalLimiter.consume(args.profileId)) {
          throw new RemoteCommandError('Zu viele Remote-Ziele. Bitte später erneut versuchen.', 429, 'rate_limited')
        }
        return dependencies.submitGoal(args.profileId, args.text)
      }
    })
    this.register({
      id: 'killSwitch.activate', capability: 'read', schema: emptySchema,
      handle: async () => {
        await dependencies.activateKillSwitch()
        return { stopping: true }
      }
    })
  }

  private register<T>(route: RemoteCommandRoute<T>): void {
    this.routes.set(route.id, route as RemoteCommandRoute)
  }

  ids(): RemoteCommandId[] {
    return [...this.routes.keys()]
  }

  resolve(id: string): RemoteCommandRoute | undefined {
    return this.routes.get(id as RemoteCommandId)
  }

  async execute(envelope: RemoteCommandEnvelope, device: DeviceInfo): Promise<unknown> {
    const route = this.resolve(String(envelope.id))
    if (!route) throw new RemoteCommandError('Unbekannter Remote-Befehl.', 404, 'not_found')
    if (!device.capabilities.includes(route.capability)) {
      throw new RemoteCommandError('Gerät besitzt nicht die erforderliche Capability.', 403, 'forbidden')
    }
    const parsed = route.schema.safeParse(envelope.args)
    if (!parsed.success) {
      throw new RemoteCommandError('Ungültige oder nicht erlaubte Befehlsargumente.', 400, 'invalid_args')
    }
    return route.handle(parsed.data)
  }
}

export const remoteCommandSchemas = { scopeSchema, goalSchema, emptySchema }
