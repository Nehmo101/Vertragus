import { describe, expect, it } from 'vitest'
import {
  EFFORT_LABELS,
  EFFORT_LEVELS,
  PROVIDER_EFFORT,
  ULTRACODE_DIRECTIVE,
  clampEffort,
  effortArgs,
  effortLevelSchema,
  effortPromptDirective,
  effortSupported,
  providerEffortLevels,
  providerSupportsEffort,
  withEffortDirective
} from './effort'
import type { AgentProviderId } from './providers'

const ALL_PROVIDERS: AgentProviderId[] = ['claude', 'kimi', 'codex', 'cursor', 'copilot', 'ollama']

describe('effort ladder', () => {
  it('labels every rung the user asked for', () => {
    expect(EFFORT_LEVELS).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
    expect(Object.values(EFFORT_LABELS)).toEqual([
      'Niedrig',
      'Mittel',
      'Hoch',
      'Extra',
      'Max',
      'Ultracode'
    ])
  })

  it('validates rungs through the schema', () => {
    for (const level of EFFORT_LEVELS) expect(effortLevelSchema.parse(level)).toBe(level)
    expect(effortLevelSchema.safeParse('balanced').success).toBe(false)
  })

  it('declares levels in ascending order per provider', () => {
    for (const provider of ALL_PROVIDERS) {
      const levels = providerEffortLevels(provider)
      const ranks = levels.map((level) => EFFORT_LEVELS.indexOf(level))
      expect(ranks).toEqual([...ranks].sort((a, b) => a - b))
    }
  })

  it('gives every provider without rungs an explanation instead of a dead dropdown', () => {
    for (const provider of ALL_PROVIDERS) {
      if (providerSupportsEffort(provider)) continue
      expect(PROVIDER_EFFORT[provider].note?.length ?? 0).toBeGreaterThan(0)
    }
  })
})

describe('clampEffort', () => {
  it('keeps a level the provider supports', () => {
    expect(clampEffort('claude', 'ultra')).toBe('ultra')
    expect(clampEffort('codex', 'medium')).toBe('medium')
  })

  it('clamps down to the nearest supported rung', () => {
    // Codex tops out at `high`, so a shared profile still runs there.
    expect(clampEffort('codex', 'xhigh')).toBe('high')
    expect(clampEffort('codex', 'max')).toBe('high')
    expect(clampEffort('codex', 'ultra')).toBe('high')
  })

  it('returns undefined for providers without an effort control', () => {
    for (const provider of ['kimi', 'cursor', 'copilot', 'ollama'] as AgentProviderId[]) {
      expect(clampEffort(provider, 'max')).toBeUndefined()
    }
  })

  it('returns undefined when nothing is selected', () => {
    expect(clampEffort('claude', undefined)).toBeUndefined()
  })

  it('agrees with effortSupported for the declared rungs', () => {
    expect(effortSupported('claude', 'xhigh')).toBe(true)
    expect(effortSupported('codex', 'xhigh')).toBe(false)
  })
})

describe('effortArgs', () => {
  it('passes the Claude Code flag verified against its --help surface', () => {
    expect(effortArgs('claude', 'low')).toEqual(['--effort', 'low'])
    expect(effortArgs('claude', 'high')).toEqual(['--effort', 'high'])
    expect(effortArgs('claude', 'xhigh')).toEqual(['--effort', 'xhigh'])
    expect(effortArgs('claude', 'max')).toEqual(['--effort', 'max'])
  })

  it('runs Ultracode as max effort — the CLI has no `ultra` value', () => {
    expect(effortArgs('claude', 'ultra')).toEqual(['--effort', 'max'])
  })

  it('uses codex config override syntax with quoted values', () => {
    expect(effortArgs('codex', 'high')).toEqual(['-c', 'model_reasoning_effort="high"'])
    expect(effortArgs('codex', 'max')).toEqual(['-c', 'model_reasoning_effort="high"'])
  })

  it('never appends a flag a provider CLI would reject', () => {
    for (const provider of ['kimi', 'cursor', 'copilot', 'ollama'] as AgentProviderId[]) {
      for (const level of EFFORT_LEVELS) expect(effortArgs(provider, level)).toEqual([])
    }
  })

  it('emits nothing when no level is selected', () => {
    for (const provider of ALL_PROVIDERS) expect(effortArgs(provider, undefined)).toEqual([])
  })
})

describe('Ultracode directive', () => {
  it('carries the prompt-level opt-in keyword', () => {
    expect(ULTRACODE_DIRECTIVE.startsWith('ultracode')).toBe(true)
  })

  it('is only injected for Claude at the top rung', () => {
    expect(effortPromptDirective('claude', 'ultra')).toBe(ULTRACODE_DIRECTIVE)
    expect(effortPromptDirective('claude', 'max')).toBeUndefined()
    expect(effortPromptDirective('codex', 'ultra')).toBeUndefined()
    expect(effortPromptDirective('claude', undefined)).toBeUndefined()
  })

  it('appends to an existing system prompt without dropping it', () => {
    expect(withEffortDirective('claude', 'ultra', 'Du bist Orchestrator.')).toBe(
      `Du bist Orchestrator.\n\n${ULTRACODE_DIRECTIVE}`
    )
  })

  it('leaves the prompt untouched for every other level', () => {
    expect(withEffortDirective('claude', 'high', 'Prompt')).toBe('Prompt')
    expect(withEffortDirective('codex', 'high', 'Prompt')).toBe('Prompt')
  })
})
