/**
 * Provider health — is this CLI actually installed and startable?
 *
 * Deliberately thin: the version probe is the one check that is both cheap and
 * conclusive. Anything richer (login state, entitlements) belongs to the
 * provider's own `auth.statusArgs` and is a separate, user-triggered action —
 * the previous generation probed accounts on every refresh and spent seconds of
 * startup on network calls that changed nothing.
 *
 * Executables resolve via PATH (never hard-coded paths), through the same
 * Windows-shim-aware launcher the discovery runner uses.
 */
import type { ProviderConfig } from '@shared/schema/provider'
import { execProviderCli, HTTP_DISCOVERY_TIMEOUT_MS } from '@main/providers/discovery'

/** A CLI that cannot print its version in 6 s is not usable interactively. */
export const HEALTH_TIMEOUT_MS = 6_000

export interface ProviderHealth {
  id: string
  available: boolean
  /** First non-empty output line of the version probe. */
  version?: string
  /** Extra one-liner, e.g. the local Ollama model count. */
  detail?: string
  error?: string
  checkedAt: number
}

export interface HealthDependencies {
  exec(command: string, args: string[], timeoutMs: number): Promise<string>
  fetchJson(url: string, timeoutMs: number): Promise<unknown>
  now(): number
}

const defaultDependencies: HealthDependencies = {
  exec: execProviderCli,
  async fetchJson(url, timeoutMs) {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return response.json()
  },
  now: () => Date.now()
}

/** First non-empty line of a command's output, trimmed. */
export function firstLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? ''
}

/**
 * Ollama is a service, not just a binary: an installed CLI whose daemon is down
 * cannot run a single model, and a running daemon is usable even when the CLI
 * probe is slow. So the local endpoint decides, and the model count is the
 * detail the user actually needs.
 */
async function ollamaDetail(
  config: ProviderConfig,
  deps: HealthDependencies
): Promise<{ available: boolean; detail: string }> {
  const url =
    config.modelDiscovery.kind === 'http'
      ? config.modelDiscovery.url
      : 'http://127.0.0.1:11434/api/tags'
  try {
    const payload = (await deps.fetchJson(url, HTTP_DISCOVERY_TIMEOUT_MS)) as {
      models?: unknown[]
    }
    return { available: true, detail: `${payload.models?.length ?? 0} local models` }
  } catch {
    return { available: false, detail: 'local service unreachable' }
  }
}

/** Probe one provider. Never throws — a failed probe IS the result. */
export async function checkProvider(
  config: ProviderConfig,
  overrides: Partial<HealthDependencies> = {}
): Promise<ProviderHealth> {
  const deps = { ...defaultDependencies, ...overrides }
  const isService = config.presetId === 'ollama'

  let version: string | undefined
  let error: string | undefined
  try {
    version = firstLine(await deps.exec(config.command, config.versionArgs, HEALTH_TIMEOUT_MS))
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }

  if (!isService) {
    return error === undefined
      ? { id: config.id, available: true, version, checkedAt: deps.now() }
      : { id: config.id, available: false, error, checkedAt: deps.now() }
  }

  const service = await ollamaDetail(config, deps)
  return {
    id: config.id,
    // The daemon is what makes Ollama usable; a present CLI alone is not enough.
    available: service.available,
    version,
    detail: service.detail,
    ...(service.available ? {} : { error: error ?? service.detail }),
    checkedAt: deps.now()
  }
}

/** Probe every provider in parallel; one slow CLI must not serialize the rest. */
export async function checkAllProviders(
  configs: readonly ProviderConfig[],
  overrides: Partial<HealthDependencies> = {}
): Promise<ProviderHealth[]> {
  return Promise.all(configs.map((config) => checkProvider(config, overrides)))
}
