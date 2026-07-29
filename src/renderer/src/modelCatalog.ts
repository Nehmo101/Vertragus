import type {
  AgentProviderId,
  ModelCatalogSource as SharedModelCatalogSource,
  ProviderModelCatalog as SharedModelCatalog,
  ProviderModelCatalogEntry
} from '@shared/providers'
import { orderedModelList } from '@shared/models'

export type ModelCatalogSource = SharedModelCatalogSource
export type ProviderModelCatalog = ProviderModelCatalogEntry
export type ModelCatalog = SharedModelCatalog

const PROVIDERS: AgentProviderId[] = ['claude', 'kimi', 'codex', 'cursor', 'copilot', 'ollama']
const MAX_MODELS_PER_PROVIDER = 1_000
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
  return {
    models: orderedModelList(models),
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
        entry.source === 'live' ||
        entry.source === 'mixed' ||
        entry.source === 'fallback' ||
        entry.source === 'unavailable'
          ? entry.source
          : 'fallback'
      const models = source === 'unavailable' ? [] : orderedModelList(modelNames(entry.models))
      const refreshedAt =
        typeof entry.refreshedAt === 'number' && Number.isFinite(entry.refreshedAt)
          ? entry.refreshedAt
          : undefined
      if ((source === 'live' || source === 'mixed') && models.length === 0) {
        return [
          provider,
          {
            models: [],
            source: 'unavailable',
            accountDependent: provider !== 'ollama',
            detail: detailText(entry.detail) ?? 'Live-Discovery hat keine Modelle gemeldet.',
            refreshedAt
          }
        ]
      }
      return [
        provider,
        {
          models,
          source,
          accountDependent: entry.accountDependent === true || provider !== 'ollama',
          detail: detailText(entry.detail),
          refreshedAt
        }
      ]
    })
  ) as ModelCatalog
}

/** Cloud CLIs keep their own default; Ollama requires an explicit local model. */
export function defaultHandoffModel(
  provider: AgentProviderId,
  catalog: ProviderModelCatalog
): string {
  return provider === 'ollama' ? catalog.models[0] ?? '' : ''
}

/** Minimal translate signature so callers can pass i18next's `t` directly. */
export type CatalogTranslate = (key: string, options?: Record<string, unknown>) => string

export function modelCatalogLabel(
  t: CatalogTranslate,
  _provider: AgentProviderId,
  catalog: ProviderModelCatalog
): string {
  if (catalog.source === 'unavailable') {
    return `${t('ui.modelCatalog.unavailable')}${
      catalog.accountDependent ? ` · ${t('ui.modelCatalog.accountDependent')}` : ''
    }`
  }
  const origin =
    catalog.source === 'live'
      ? t('ui.modelCatalog.live')
      : catalog.source === 'mixed'
        ? t('ui.modelCatalog.mixed')
        : t('ui.modelCatalog.fallback')
  const counted =
    catalog.source === 'fallback'
      ? t('ui.modelCatalog.suggestions', { n: catalog.models.length })
      : t('ui.modelCatalog.models', { n: catalog.models.length })
  const account =
    catalog.source === 'fallback' && catalog.accountDependent
      ? ` · ${t('ui.modelCatalog.notAccountVerified')}`
      : catalog.accountDependent
        ? ` · ${t('ui.modelCatalog.accountDependent')}`
        : ''
  return `${origin} · ${counted}${account}${refreshedSuffix(t, catalog)}`
}

/**
 * "aktualisiert 14:32" — proof that the list is discovered, not hardcoded. The
 * catalogue re-discovers itself periodically, so the timestamp is what tells a
 * user whether a just-released model should already be in there.
 */
export function refreshedSuffix(t: CatalogTranslate, catalog: ProviderModelCatalog): string {
  if (!catalog.refreshedAt) return ''
  const time = new Date(catalog.refreshedAt).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit'
  })
  return ` · ${t('ui.modelCatalog.refreshedAt', { time })}`
}
