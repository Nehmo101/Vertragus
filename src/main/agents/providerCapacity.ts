/**
 * Per-provider concurrency gate — enforces Orca's user-configured local
 * `providerLimits` process gates in the main process. Interactive spawns fail
 * when full; headless tasks wait. Lowering a gate never stops running agents.
 */
import {
  DEFAULT_PROVIDER_LIMITS,
  normalizeProviderLimits,
  type AgentProviderId
} from '@shared/providers'
import { getSetting } from '@main/config/store'
import { Semaphore } from '@main/orchestrator/semaphore'

export class ProviderLimitError extends Error {
  readonly provider: AgentProviderId
  readonly limit: number

  constructor(provider: AgentProviderId, limit: number) {
    super(`Orca-Gate erreicht: ${provider} (${limit} parallel, keine API-Quote).`)
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
    return normalizeProviderLimits(stored)[provider]
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

  statsAll(): Record<AgentProviderId, ProviderCapacityStats> {
    const out = {} as Record<AgentProviderId, ProviderCapacityStats>
    for (const provider of AGENT_PROVIDERS) {
      out[provider] = this.stats(provider)
    }
    return out
  }
}

export const providerCapacity = new ProviderCapacityGate()
