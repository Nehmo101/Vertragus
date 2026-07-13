import type { AgentProviderId } from '@shared/providers'

export type ModelCatalogSource = 'live' | 'fallback' | 'unavailable'

export interface ProviderModelCatalog {
  models: string[]
  source: ModelCatalogSource
  /** A visible model or preset can still depend on the signed-in plan. */
  accountDependent: boolean
}

export type ModelCatalog = Record<AgentProviderId, ProviderModelCatalog>

const PROVIDERS: AgentProviderId[] = ['claude', 'codex', 'cursor', 'copilot', 'ollama']
const MAX_MODELS_PER_PROVIDER = 200

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function modelNames(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') continue
    const name = item.trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    if (seen.size === MAX_MODELS_PER_PROVIDER) break
  }
  return [...seen]
}

function fallbackCatalog(provider: AgentProviderId, models: string[] = []): ProviderModelCatalog {
  // Cursor choices must be verified by `cursor-agent models`; curated guesses
  // routinely include models that are not enabled for the current account.
  if (provider === 'cursor') {
    return { models: [], source: 'unavailable', accountDependent: true }
  }
  return {
    models,
    source: 'fallback',
    accountDependent: provider === 'claude' || provider === 'codex'
  }
}

/**
 * Renderer-side compatibility adapter for `window.orca.listModels()`.
 *
 * The existing IPC response is a record of string arrays. The model-sync
 * integrator may upgrade it to the structured entry below without requiring a
 * renderer migration:
 *
 *   { models: string[], source: 'live' | 'fallback', accountDependent?: boolean }
 *
 * Integration contract:
 * - Prefer successful live discovery and put those values before a fallback.
 *   Use `source: 'live'` only when the CLI/API actually returned the list.
 * - For Codex, preserve the account-exposed `terra` and `sol` identifiers
 *   verbatim and mark the entry `accountDependent: true`; never guess that
 *   either identifier is available to another account.
 * - Cursor is live-only: on an unavailable/failed/unauthenticated discovery,
 *   return `{ models: [], source: 'fallback', accountDependent: true }`.
 *   Do not merge curated Cursor names into that response.
 * - Claude presets remain account-aware. Mark Claude entries
 *   `accountDependent: true`; the preset picker is a convenience, not an
 *   entitlement guarantee, and an explicit model must continue to win.
 *
 * Keep the shared IPC and preload typings in lockstep when the structured
 * response is introduced. This module intentionally stays renderer-local.
 */
export function normalizeModelCatalog(value: unknown): ModelCatalog {
  const response = isRecord(value) ? value : {}
  return Object.fromEntries(
    PROVIDERS.map((provider) => {
      const entry = response[provider]
      if (Array.isArray(entry)) return [provider, fallbackCatalog(provider, modelNames(entry))]
      if (!isRecord(entry)) return [provider, fallbackCatalog(provider)]

      const source = entry.source === 'live' || entry.source === 'fallback' ? entry.source : 'fallback'
      const models = modelNames(entry.models)
      if (provider === 'cursor' && source !== 'live') {
        return [provider, { models: [], source: 'unavailable', accountDependent: true }]
      }
      return [
        provider,
        {
          models,
          source,
          accountDependent:
            entry.accountDependent === true || provider === 'claude' || provider === 'codex'
        }
      ]
    })
  ) as ModelCatalog
}

export function modelCatalogLabel(provider: AgentProviderId, catalog: ProviderModelCatalog): string {
  if (provider === 'cursor' && catalog.source !== 'live') {
    return 'Live-Liste nötig · kontoabhängig'
  }

  const origin = catalog.source === 'live' ? 'Live' : 'Fallback'
  const account =
    provider === 'claude'
      ? ' · Claude-Presets kontoabhängig'
      : provider === 'codex'
        ? ' · Codex terra/sol kontoabhängig'
        : catalog.accountDependent
          ? ' · kontoabhängig'
          : ''
  return `${origin} · ${catalog.models.length} Modelle${account}`
}
