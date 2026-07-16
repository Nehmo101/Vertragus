import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveModel, type ModelSelection } from '@shared/models'
import type { AgentProviderId } from '@shared/providers'

/**
 * Telemetry fallback label when a codex slot relies on ~/.codex/config.toml
 * and the config does not name a model either. Never an empty string: retros
 * grouped every unattributed codex task under model:"" and made the stored
 * learnings unusable ("Orca lieferte keinen Modellnamen").
 */
export const CODEX_CONFIG_DEFAULT_LABEL = 'default (codex-config)'

let cachedCodexDefault: { value: string | undefined } | undefined

/** Top-level `model = "…"` from ~/.codex/config.toml, read once per process. */
export function detectCodexDefaultModel(): string | undefined {
  if (cachedCodexDefault) return cachedCodexDefault.value
  let value: string | undefined
  try {
    const raw = readFileSync(join(homedir(), '.codex', 'config.toml'), 'utf8')
    value = /^[ \t]*model[ \t]*=[ \t]*"([^"\n]+)"/m.exec(raw)?.[1]?.trim() || undefined
  } catch {
    value = undefined
  }
  cachedCodexDefault = { value }
  return value
}

export function resetCodexDefaultModelCacheForTest(): void {
  cachedCodexDefault = undefined
}

/**
 * Model id for task records, list_subagents, attempts and retros. Falls back
 * to the codex config default (or a stable label) instead of '' so learnings
 * stay attributable to a concrete model.
 */
export function resolveSlotModel(provider: AgentProviderId, sel: ModelSelection): string {
  const explicit = resolveModel(provider, sel)
  if (explicit) return explicit
  if (provider === 'codex') return detectCodexDefaultModel() ?? CODEX_CONFIG_DEFAULT_LABEL
  return `default (${provider}-cli)`
}
