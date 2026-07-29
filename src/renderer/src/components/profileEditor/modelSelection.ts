/**
 * Model/effort picker helpers shared by the orchestrator block and the agent
 * slot rows. Pure functions over the store's catalog snapshot so memoized
 * sections can call them without subscribing to the store themselves.
 */
import type { AgentProviderId, DisabledModels } from '@shared/providers'
import type { EffortLevel } from '@shared/effort'
import {
  EFFORT_LABELS,
  EFFORT_LEVELS,
  PROVIDER_EFFORT,
  clampEffort,
  providerEffortLevels,
  providerSupportsEffort
} from '@shared/effort'
import type { ModelCatalog } from '@renderer/modelCatalog'

/** Minimal translate signature so i18next's `t` can be passed straight through. */
export type ModelTranslate = (key: string, options?: Record<string, unknown>) => string

/** Localized effort label; falls back to the shared (German-authored) constant. */
export function effortLabel(t: ModelTranslate, level: EffortLevel): string {
  return t(`profile.effort.${level}`, { defaultValue: EFFORT_LABELS[level] })
}

/**
 * Effort option label including the name the SELECTED provider uses, e.g.
 * "Hoch · high" for Claude and "Hoch · high" (model_reasoning_effort) for Codex.
 * The bare rung said nothing about what the provider actually receives.
 */
export function effortOptionLabel(
  t: ModelTranslate,
  provider: AgentProviderId,
  level: EffortLevel
): string {
  const label = effortLabel(t, level)
  const name = PROVIDER_EFFORT[provider].names?.[level]
  return name ? t('profile.mode.effortHint', { effort: label, name }) : label
}

/** What this provider calls the setting, e.g. "Reasoning Effort". */
export function effortTerm(provider: AgentProviderId): string {
  return PROVIDER_EFFORT[provider].term
}

/** Why a provider offers no rungs (shown instead of a dead dropdown). */
export function effortNote(provider: AgentProviderId): string | undefined {
  return PROVIDER_EFFORT[provider].note
}

/** Selectable rungs for a provider, ascending. Empty = no effort control. */
export function effortOptions(provider: AgentProviderId): readonly EffortLevel[] {
  return providerEffortLevels(provider)
}

export function effortValue(level?: EffortLevel): string {
  return level ?? ''
}

export function parseEffort(value: string): EffortLevel | undefined {
  return (EFFORT_LEVELS as readonly string[]).includes(value) ? (value as EffortLevel) : undefined
}

export { providerSupportsEffort }

/**
 * True when the saved rung is higher than the provider can serve, so the run
 * silently clamps down. Surfaced as a hint instead of rewriting the profile —
 * switching the provider back must restore the original intent.
 */
export function effortClamped(provider: AgentProviderId, level?: EffortLevel): boolean {
  // Providers without any effort control are not "clamped" — they ignore the
  // field outright, and the disabled dropdown already says so.
  if (!level || !providerSupportsEffort(provider)) return false
  return clampEffort(provider, level) !== level
}

/** The rung the run will actually use, for the "effective" line. */
export function effectiveEffortLabel(
  t: ModelTranslate,
  provider: AgentProviderId,
  level?: EffortLevel
): string {
  const clamped = clampEffort(provider, level)
  return clamped ? effortOptionLabel(t, provider, clamped) : t('profile.cliDefault')
}

/** Localized label for the effective model (resolved id or CLI default). */
export function effectiveModelLabel(t: ModelTranslate, resolved: string): string {
  return resolved || t('profile.cliDefault')
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
