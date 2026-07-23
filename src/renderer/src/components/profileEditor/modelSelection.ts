/**
 * Model/preset picker helpers shared by the orchestrator block and the agent
 * slot rows. Pure functions over the store's catalog snapshot so memoized
 * sections can call them without subscribing to the store themselves.
 */
import type { AgentProviderId, DisabledModels } from '@shared/providers'
import type { ModelPreset } from '@shared/models'
import type { ModelCatalog } from '@renderer/modelCatalog'
import { modelPresetAvailability } from '@renderer/modelCatalog'

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
