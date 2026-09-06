import type { ProviderConfig } from '@shared/schema/provider'
import type { AgentSeat } from '@shared/schema/reseat'
import { checkProvider, type ProviderHealth } from './health'
import { checkProviderAuth, type ProviderAuthStatus } from './authStatus'
import { discoverModels, execProviderCli, type ModelDiscoveryResult } from './discovery'

export const SEAT_PROBE_TIMEOUT_MS = 6_000
export interface SeatPreflightDependencies {
  health(provider: ProviderConfig): Promise<ProviderHealth>
  auth(provider: ProviderConfig): Promise<ProviderAuthStatus>
  models(provider: ProviderConfig): Promise<ModelDiscoveryResult>
}

const defaults: SeatPreflightDependencies = {
  health: checkProvider,
  auth: checkProviderAuth,
  models: (provider) => discoverModels(provider, {
    exec: (command, args, timeout) => execProviderCli(command, args, Math.min(timeout, SEAT_PROBE_TIMEOUT_MS))
  })
}

/** Unknown discovery/auth remains unknown; a missing executable is a hard failure. */
export async function preflightSeat(
  provider: ProviderConfig,
  seat: AgentSeat,
  overrides: Partial<SeatPreflightDependencies> = {}
): Promise<void> {
  if (provider.id !== seat.providerId) throw new Error('Seat provider does not match its descriptor')
  const deps = { ...defaults, ...overrides }
  const [health, auth, models] = await Promise.all([
    bounded(() => deps.health(provider)),
    bounded(() => deps.auth(provider)),
    bounded(() => deps.models(provider))
  ])
  if (!health?.available) throw new Error(health?.error ?? 'Provider availability could not be verified within 6 seconds')
  if (auth?.state === 'logged-out') throw new Error(auth.loginCommand ? `Provider login required: ${auth.loginCommand}` : 'Provider login required')
  // File caches, memory and aliases may be incomplete. Only a successful live
  // CLI or HTTP catalogue can authoritatively reject a model identifier.
  const authoritative = models?.source === 'live' && !models.detail &&
    (provider.modelDiscovery.kind === 'cli' || provider.modelDiscovery.kind === 'http')
  if (seat.model && authoritative && !models.models.includes(seat.model)) {
    throw new Error(`Provider does not offer model: ${seat.model}`)
  }
  if (!seat.effort) return
  if (!provider.effortArg) throw new Error('Provider does not support an explicit effort')
  const supported = (seat.model ? models?.efforts?.[seat.model] : undefined) ?? provider.effortLevels
  if (supported.length > 0 && !supported.includes(seat.effort)) {
    throw new Error(`Provider/model does not support effort: ${seat.effort}`)
  }
}

async function bounded<T>(probe: () => Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(probe).catch(() => undefined),
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), SEAT_PROBE_TIMEOUT_MS) })
    ])
  } finally { clearTimeout(timer) }
}
