/**
 * Model catalog + performance presets (fast | balanced | strong).
 *
 * Resolution order (backwards compatible):
 * 1. Non-empty free-text `model` wins (explicit override in Profile-Editor).
 * 2. Else `modelPreset` maps via provider-specific PRESET_MODELS.
 * 3. Else empty string → omit CLI --model (provider default).
 *
 * Legacy profiles without modelPreset keep step 3 when model is empty (e.g. codex
 * using ~/.codex/config.toml).
 */
import { z } from 'zod'
import type { AgentProviderId } from './providers'

export const MODEL_PRESETS = ['fast', 'balanced', 'strong'] as const
export type ModelPreset = (typeof MODEL_PRESETS)[number]

export const modelPresetSchema = z.enum(MODEL_PRESETS)

export const MODEL_PRESET_LABELS: Record<ModelPreset, string> = {
  fast: 'Schnell',
  balanced: 'Ausgewogen',
  strong: 'Stark'
}

/** Provider-specific preset → model id. Empty = CLI default where applicable. */
export const PRESET_MODELS: Record<AgentProviderId, Record<ModelPreset, string>> = {
  claude: {
    fast: 'haiku',
    balanced: 'sonnet',
    strong: 'opus'
  },
  kimi: {
    fast: 'kimi-k3-turbo',
    balanced: 'kimi-k3',
    strong: 'kimi-k3-thinking'
  },
  codex: {
    fast: 'gpt-5.4-mini',
    balanced: 'gpt-5.6-terra',
    strong: 'gpt-5.6-sol'
  },
  cursor: {
    fast: 'composer-2.5-fast',
    balanced: 'composer-2.5',
    strong: 'claude-opus-4-8-high'
  },
  copilot: {
    fast: 'claude-haiku-4.5',
    balanced: 'claude-sonnet-4.6',
    strong: 'gpt-5.4'
  },
  ollama: {
    fast: 'qwen2.5-coder:14b',
    balanced: 'qwen2.5-coder:32b',
    strong: 'llama3.3:70b'
  }
}

export interface ModelSelection {
  model?: string
  modelPreset?: ModelPreset
}

/** Resolve the model id passed to provider CLIs as --model (or codex -c model=). */
export function resolveModel(provider: AgentProviderId, sel: ModelSelection): string {
  const explicit = sel.model?.trim()
  if (explicit) return explicit
  if (sel.modelPreset !== undefined) return PRESET_MODELS[provider][sel.modelPreset] ?? ''
  return ''
}

/**
 * Value the model field must hold after a provider `<select>` change.
 *
 * A same-value reselect (or any onChange where the provider is unchanged) must
 * keep an explicitly chosen model — clearing it would let the preset/CLI default
 * silently override a saved id and persist an empty `model` to the store. Only a
 * real provider switch clears the field so a stale, incompatible id never carries
 * over; `modelPreset` is handled separately and is intentionally preserved.
 */
export function modelAfterProviderChange(
  prev: AgentProviderId,
  next: AgentProviderId,
  currentModel: string
): string {
  return prev === next ? currentModel : ''
}

/** UI label for the effective model (resolved or CLI default). */
export function formatModelLabel(resolved: string, sel?: ModelSelection): string {
  if (resolved) return resolved
  if (sel?.modelPreset) return `CLI-Standard (${MODEL_PRESET_LABELS[sel.modelPreset]})`
  return 'CLI-Standard'
}
