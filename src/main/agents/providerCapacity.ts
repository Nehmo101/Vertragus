/**
 * Per-provider concurrency gate — enforces the user-configured `providerLimits`
 * budget on the main process. Interactive spawns fail when full; headless tasks
 * wait. Lowering a limit never stops agents that are already running.
 */
import { DEFAULT_PROVIDER_LIMITS, type AgentProviderId } from '@shared/providers'
import { getSetting } from '@main/config/store'
import { Semaphore } from '@main/orchestrator/semaphore'

export class ProviderLimitError extends Error {
  readonly provider: AgentProviderId
  readonly limit: number

  constructor(provider: AgentProviderId, limit: number) {
    super(`Provider-Limit erreicht: ${provider} (${limit} parallel).`)
    this.name = 'ProviderLimitError'
    this.provider = provider
    this.limit = limit
  }
}

export interface ProviderCapacityStats {
  active: number
  waiting: number
  limit: number
}

const AGENT_PROVIDERS = Object.keys(DEFAULT_PROVIDER_LIMITS) as AgentProviderId[]

class ProviderCapacityGate {
  private readonly gates = new Map<AgentProviderId, Semaphore>()

  private limitFor(provider: AgentProviderId): number {
    const stored = getSetting<Partial<Record<AgentProviderId, number>>>('providerLimits')
    const value = stored?.[provider] ?? DEFAULT_PROVIDER_LIMITS[provider]
    return Math.max(1, value)
  }

  private gate(provider: AgentProviderId): Semaphore {
    let sem = this.gates.get(provider)
    if (!sem) {
      sem = new Semaphore(this.limitFor(provider))
      this.gates.set(provider, sem)
    }
    return sem
  }

  refreshLimits(): void {
    for (const provider of AGENT_PROVIDERS) {
      this.gate(provider).setLimit(this.limitFor(provider))
    }
  }

  /** Fail fast when the provider is at capacity (manual interactive spawns). */
  tryAcquire(provider: AgentProviderId): void {
    const sem = this.gate(provider)
    if (!sem.tryAcquire()) throw new ProviderLimitError(provider, sem.limitValue)
  }

  /** Wait for a free slot (automatic headless tasks). */
  async acquireWait(provider: AgentProviderId, signal?: { aborted: boolean }): Promise<boolean> {
    const sem = this.gate(provider)
    await sem.acquire()
    if (signal?.aborted) {
      sem.release()
      return false
    }
    return true
  }

  release(provider: AgentProviderId): void {
    this.gate(provider).release()
  }

  stats(provider: AgentProviderId): ProviderCapacityStats {
    const sem = this.gate(provider)
    return { active: sem.inUse, waiting: sem.waiting, limit: sem.limitValue }
  }
}

export const providerCapacity = new ProviderCapacityGate()
