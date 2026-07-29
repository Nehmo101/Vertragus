/**
 * Reasoning-effort ("Aufwand") levels — the per-run knob that decides how much
 * thinking and tool work an agent spends, independent of WHICH model runs.
 *
 * This replaces the old model-tier presets (fast/balanced/strong), which merely
 * picked a model id and therefore duplicated the model field. Effort is the
 * setting the CLIs actually expose:
 *
 * - Claude Code:  `--effort low|medium|high|xhigh|max`
 * - Codex:        `-c model_reasoning_effort="low|medium|high"`
 * - Kimi/Cursor:  no flag — depth lives in the model id (…-thinking, …-high)
 * - Copilot/Ollama: no effort control at all
 *
 * Vertragus keeps ONE canonical ladder so profiles stay portable across
 * providers, and each provider declares which rungs it supports plus the name
 * IT uses for them. A level a provider cannot serve is clamped down to the
 * nearest supported rung instead of being passed through as an unknown flag —
 * an unknown CLI flag kills the launch.
 */
import { z } from 'zod'
import type { AgentProviderId } from './providers'

/** Canonical ladder, ascending. `ultra` is Vertragus' own top rung (see below). */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const
export type EffortLevel = (typeof EFFORT_LEVELS)[number]

export const effortLevelSchema = z.enum(EFFORT_LEVELS)

/** German-authored labels; the renderer overrides them via i18n. */
export const EFFORT_LABELS: Record<EffortLevel, string> = {
  low: 'Niedrig',
  medium: 'Mittel',
  high: 'Hoch',
  xhigh: 'Extra',
  max: 'Max',
  ultra: 'Ultracode'
}

export function effortRank(level: EffortLevel): number {
  return EFFORT_LEVELS.indexOf(level)
}

export interface ProviderEffortDef {
  /** What the provider itself calls this setting, e.g. "Reasoning Effort". */
  term: string
  /** Supported rungs, ascending. Empty = provider exposes no effort control. */
  levels: readonly EffortLevel[]
  /** The provider's own name per rung, shown next to the Vertragus label. */
  names?: Partial<Record<EffortLevel, string>>
  /** Why there are no levels / where the depth comes from instead. */
  note?: string
}

/**
 * Per-provider effort surface. Only flags verified against the installed CLI's
 * `--help` (Claude Code) or its documented `-c key=value` config surface
 * (Codex) are declared — everything else stays deliberately empty so Vertragus
 * never appends a flag a CLI would reject.
 */
export const PROVIDER_EFFORT: Record<AgentProviderId, ProviderEffortDef> = {
  claude: {
    term: 'Effort',
    levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    names: {
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      max: 'max',
      // Claude Code has no `ultra` rung: Ultracode is `--effort max` plus the
      // multi-agent orchestration opt-in injected into the system prompt.
      ultra: 'max + ultracode'
    }
  },
  kimi: {
    term: 'Thinking-Variante',
    levels: [],
    note: 'Die Kimi-CLI kennt keinen Effort-Schalter — Tiefe kommt über das Modell (kimi-k3-thinking).'
  },
  codex: {
    term: 'Reasoning Effort',
    levels: ['low', 'medium', 'high'],
    names: { low: 'low', medium: 'medium', high: 'high' }
  },
  cursor: {
    term: 'Modellstufe',
    levels: [],
    note: 'cursor-agent steuert den Aufwand über das Modell-Suffix (z. B. claude-opus-4-8-high).'
  },
  copilot: {
    term: '—',
    levels: [],
    note: 'Die Copilot-CLI bietet keine Aufwandsstufen; das gewählte Modell entscheidet.'
  },
  ollama: {
    term: '—',
    levels: [],
    note: 'Lokale Ollama-Modelle haben keinen Aufwandsschalter.'
  }
}

export function providerEffortLevels(provider: AgentProviderId): readonly EffortLevel[] {
  return PROVIDER_EFFORT[provider].levels
}

export function providerSupportsEffort(provider: AgentProviderId): boolean {
  return PROVIDER_EFFORT[provider].levels.length > 0
}

export function effortSupported(provider: AgentProviderId, level: EffortLevel): boolean {
  return PROVIDER_EFFORT[provider].levels.includes(level)
}

/**
 * Nearest supported rung at or below `level`, so a profile shared across
 * providers keeps working: Codex has no `xhigh`/`max`, so both run as `high`.
 * Returns undefined when the provider has no effort control — the caller then
 * leaves the CLI at its own default.
 */
export function clampEffort(
  provider: AgentProviderId,
  level: EffortLevel | undefined
): EffortLevel | undefined {
  if (!level) return undefined
  const levels = PROVIDER_EFFORT[provider].levels
  if (levels.length === 0) return undefined
  if (levels.includes(level)) return level
  const wanted = effortRank(level)
  let best: EffortLevel | undefined
  for (const candidate of levels) {
    if (effortRank(candidate) <= wanted) best = candidate
  }
  // `level` sits below every supported rung (cannot happen today) — take the
  // lowest one rather than silently dropping the user's intent.
  return best ?? levels[0]
}

/** CLI args that select the level, or [] when the provider has no such flag. */
export function effortArgs(
  provider: AgentProviderId,
  level: EffortLevel | undefined
): string[] {
  const clamped = clampEffort(provider, level)
  if (!clamped) return []
  switch (provider) {
    case 'claude':
      // Ultracode is max effort plus a prompt directive (see below).
      return ['--effort', clamped === 'ultra' ? 'max' : clamped]
    case 'codex':
      // Same quoting style as the other codex overrides in providers/types.ts.
      return ['-c', `model_reasoning_effort=${JSON.stringify(clamped)}`]
    default:
      return []
  }
}

/**
 * The Ultracode directive. `ultracode` is a prompt-level opt-in (not a CLI
 * flag): it tells Claude Code that multi-agent orchestration is authorised for
 * the whole session, which is exactly what the top rung is supposed to buy.
 * Callers append this to the system prompt they already build.
 */
export const ULTRACODE_DIRECTIVE = [
  'ultracode',
  'Aufwandsstufe Ultracode: Multi-Agent-Orchestrierung ist für diese Sitzung freigegeben.',
  'Fächere umfangreiche Aufgaben über parallele Subagents/Workflows auf, verifiziere Ergebnisse',
  'gegenläufig und arbeite erschöpfend statt sparsam — Tokenkosten sind hier kein Kriterium.'
].join('\n')

/** System-prompt suffix for a level, or undefined when nothing is needed. */
export function effortPromptDirective(
  provider: AgentProviderId,
  level: EffortLevel | undefined
): string | undefined {
  return provider === 'claude' && clampEffort(provider, level) === 'ultra'
    ? ULTRACODE_DIRECTIVE
    : undefined
}

/** Append the effort directive to a system prompt the caller already built. */
export function withEffortDirective(
  provider: AgentProviderId,
  level: EffortLevel | undefined,
  systemPrompt: string
): string {
  const directive = effortPromptDirective(provider, level)
  if (!directive) return systemPrompt
  const base = systemPrompt.trim()
  return base ? `${base}\n\n${directive}` : directive
}

/** Effective level after clamping — what the run will actually use. */
export function resolveEffort(
  provider: AgentProviderId,
  level: EffortLevel | undefined
): EffortLevel | undefined {
  return clampEffort(provider, level)
}
