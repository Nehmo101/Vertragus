import type {
  AgentProviderId,
  ModelCatalogSource as SharedModelCatalogSource,
  ProviderModelCatalog as SharedModelCatalog,
  ProviderModelCatalogEntry
} from '@shared/providers'
import { PRESET_MODELS, type ModelPreset } from '@shared/models'

export type ModelCatalogSource = SharedModelCatalogSource
export type ProviderModelCatalog = ProviderModelCatalogEntry
export type ModelCatalog = SharedModelCatalog

const PROVIDERS: AgentProviderId[] = ['claude', 'codex', 'cursor', 'copilot', 'ollama']
const MAX_MODELS_PER_PROVIDER = 200
const MAX_DETAIL_LENGTH = 300

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

function detailText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const detail = value.trim()
  if (!detail) return undefined
  return detail.slice(0, MAX_DETAIL_LENGTH)
}

function fallbackCatalog(provider: AgentProviderId, models: string[] = []): ProviderModelCatalog {
  // Claude and Cursor choices are strictly live-only. Legacy array responses must never
  // reintroduce curated guesses from older Orca versions.
  if (provider === 'cursor' || provider === 'claude') {
    return {
      models: [],
      source: 'unavailable',
      accountDependent: true,
      detail:
        provider === 'cursor'
          ? 'Live-Liste von cursor-agent models erforderlich.'
          : 'Claude-Account-Katalog erforderlich.'
    }
  }
  return {
    models,
    source: 'fallback',
    accountDependent: provider !== 'ollama',
    detail: 'Kuratierte Vorschläge; Konto-Verfügbarkeit nicht verifiziert.'
  }
}

/** Validate the model catalogue received at the IPC boundary. */
export function normalizeModelCatalog(value: unknown): ModelCatalog {
  const response = isRecord(value) ? value : {}
  return Object.fromEntries(
    PROVIDERS.map((provider) => {
      const entry = response[provider]
      if (Array.isArray(entry)) return [provider, fallbackCatalog(provider, modelNames(entry))]
      if (!isRecord(entry)) return [provider, fallbackCatalog(provider)]

      const source: ModelCatalogSource =
        entry.source === 'live' || entry.source === 'fallback' || entry.source === 'unavailable'
          ? entry.source
          : 'fallback'
      const models = source === 'unavailable' ? [] : modelNames(entry.models)
      if ((provider === 'cursor' || provider === 'claude') && source !== 'live') {
        return [
          provider,
          {
            models: [],
            source: 'unavailable',
            accountDependent: true,
            detail:
              detailText(entry.detail) ??
              (provider === 'cursor'
                ? 'Live-Liste von cursor-agent models erforderlich.'
                : 'Claude-Account-Katalog erforderlich.')
          }
        ]
      }
      if (source === 'live' && models.length === 0) {
        return [
          provider,
          {
            models: [],
            source: 'unavailable',
            accountDependent: provider !== 'ollama',
            detail: detailText(entry.detail) ?? 'Live-Discovery hat keine Modelle gemeldet.'
          }
        ]
      }
      return [
        provider,
        {
          models,
          source,
          accountDependent:
            entry.accountDependent === true || provider === 'claude' || provider === 'codex',
          detail: detailText(entry.detail)
        }
      ]
    })
  ) as ModelCatalog
}

/**
 * Concrete presets are selectable only when a live account catalogue contains
 * their target. Empty targets intentionally mean "use the provider CLI default".
 */
export function modelPresetAvailability(
  provider: AgentProviderId,
  preset: ModelPreset,
  catalog: ProviderModelCatalog
): { available: boolean; target: string; reason?: string } {
  const target = PRESET_MODELS[provider][preset] ?? ''
  if (!target) return { available: true, target }
  if (catalog.source === 'live' && catalog.models.includes(target)) {
    return { available: true, target }
  }
  return {
    available: false,
    target,
    reason:
      catalog.source === 'live'
        ? `${target} ist für dieses Konto nicht verfügbar.`
        : `${target} ist ohne Live-Katalog nicht verifiziert.`
  }
}

/** Handoffs default only to a model verified by the current live catalogue. */
export function defaultHandoffModel(catalog: ProviderModelCatalog): string {
  return catalog.source === 'live' ? catalog.models[0] ?? '' : ''
}

export function modelCatalogLabel(
  _provider: AgentProviderId,
  catalog: ProviderModelCatalog
): string {
  if (catalog.source === 'unavailable') {
    return `Nicht verfügbar${catalog.accountDependent ? ' · kontoabhängig' : ''}`
  }
  const origin = catalog.source === 'live' ? 'Live' : 'Fallback'
  const noun = catalog.source === 'live' ? 'Modelle' : 'Vorschläge'
  const account =
    catalog.source === 'fallback' && catalog.accountDependent
      ? ' · nicht kontoverifiziert'
      : catalog.accountDependent
        ? ' · kontoabhängig'
        : ''
  return `${origin} · ${catalog.models.length} ${noun}${account}`
}
