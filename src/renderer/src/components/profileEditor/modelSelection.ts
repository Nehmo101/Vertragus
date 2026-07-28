/**
 * Model/preset picker helpers shared by the orchestrator block and the agent
 * slot rows. Pure functions over the store's catalog snapshot so memoized
 * sections can call them without subscribing to the store themselves.
 */
import type { AgentProviderId, DisabledModels } from '@shared/providers'
import type { ModelPreset, ModelSelection } from '@shared/models'
import { MODEL_PRESET_LABELS } from '@shared/models'
import type { ModelCatalog } from '@renderer/modelCatalog'
import { modelPresetAvailability } from '@renderer/modelCatalog'

/** Minimal translate signature so i18next's `t` can be passed straight through. */
export type ModelTranslate = (key: string, options?: Record<string, unknown>) => string

/** Localized preset label; falls back to the shared (German-authored) constant. */
export function presetLabel(t: ModelTranslate, preset: ModelPreset): string {
  return t(`profile.preset.${preset}`, { defaultValue: MODEL_PRESET_LABELS[preset] })
}

/** Localized twin of @shared/models#formatModelLabel (resolved model or CLI default). */
export function effectiveModelLabel(
  t: ModelTranslate,
  resolved: string,
  sel?: ModelSelection
): string {
  if (resolved) return resolved
  if (sel?.modelPreset) return `${t('profile.cliDefault')} (${presetLabel(t, sel.modelPreset)})`
  return t('profile.cliDefault')
}

/** Catalog models of a provider minus the user-disabled ones (case-insensitive). */
export function availableModels(
  models: ModelCatalog,
  disabledModels: DisabledModels,
  provider: AgentProviderId
): string[] {
  return models[provider].models.filter(
    (model) => !disabledModels[provider].some(
      (disabled) => disabled.toLowerCase() === model.toLowerCase()
    )
  )
}

export function presetValue(preset?: ModelPreset): string {
  return preset ?? ''
}

export function parsePreset(value: string): ModelPreset | undefined {
  return value === 'fast' || value === 'balanced' || value === 'strong' ? value : undefined
}

export function presetAvailable(
  models: ModelCatalog,
  provider: AgentProviderId,
  preset: ModelPreset
): boolean {
  return modelPresetAvailability(provider, preset, models[provider]).available
}

/** True when the selection relies on a preset the live catalog cannot serve. */
export function selectionHasUnavailablePreset(
  models: ModelCatalog,
  provider: AgentProviderId,
  model: string,
  preset?: ModelPreset
): boolean {
  return Boolean(!model.trim() && preset && !presetAvailable(models, provider, preset))
}
