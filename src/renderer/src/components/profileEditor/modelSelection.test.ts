import { describe, expect, it } from 'vitest'
import i18n from '@renderer/i18n'
import {
  effectiveEffortLabel,
  effortClamped,
  effortOptionLabel,
  effortOptions,
  effortTerm,
  parseEffort,
  providerSupportsEffort
} from './modelSelection'

// Assert the German source copy, independent of the host locale.
const t = i18n.getFixedT('de')

describe('effortOptionLabel', () => {
  it('names the rung plus the value the provider actually receives', () => {
    expect(effortOptionLabel(t, 'claude', 'low')).toBe('Niedrig · low')
    expect(effortOptionLabel(t, 'claude', 'medium')).toBe('Mittel · medium')
    expect(effortOptionLabel(t, 'claude', 'high')).toBe('Hoch · high')
    expect(effortOptionLabel(t, 'claude', 'xhigh')).toBe('Extra · xhigh')
    expect(effortOptionLabel(t, 'claude', 'max')).toBe('Max · max')
  })

  it('shows how Ultracode is delivered', () => {
    expect(effortOptionLabel(t, 'claude', 'ultra')).toBe('Ultracode · max + ultracode')
  })

  it('uses the provider naming, so the same rung reads per provider', () => {
    expect(effortOptionLabel(t, 'codex', 'high')).toBe('Hoch · high')
    expect(effortTerm('codex')).toBe('Reasoning Effort')
    expect(effortTerm('claude')).toBe('Effort')
  })
})

describe('effortOptions', () => {
  it('offers all six rungs for Claude', () => {
    expect(effortOptions('claude')).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
    expect(providerSupportsEffort('claude')).toBe(true)
  })

  it('offers only what Codex accepts', () => {
    expect(effortOptions('codex')).toEqual(['low', 'medium', 'high'])
  })

  it('offers nothing for providers without an effort control', () => {
    for (const provider of ['kimi', 'cursor', 'copilot', 'ollama'] as const) {
      expect(effortOptions(provider)).toEqual([])
      expect(providerSupportsEffort(provider)).toBe(false)
    }
  })
})

describe('parseEffort', () => {
  it('accepts every rung and rejects anything else', () => {
    expect(parseEffort('ultra')).toBe('ultra')
    expect(parseEffort('')).toBeUndefined()
    expect(parseEffort('balanced')).toBeUndefined()
  })
})

describe('effortClamped', () => {
  it('flags a rung the provider cannot serve', () => {
    expect(effortClamped('codex', 'max')).toBe(true)
    expect(effortClamped('codex', 'high')).toBe(false)
    expect(effortClamped('claude', 'ultra')).toBe(false)
    expect(effortClamped('claude', undefined)).toBe(false)
  })

  it('does not flag providers that ignore effort entirely', () => {
    // Nothing is clamped there — the CLI simply has no such setting.
    expect(effortClamped('ollama', 'max')).toBe(false)
  })
})

describe('effectiveEffortLabel', () => {
  it('reports the rung the run will really use', () => {
    expect(effectiveEffortLabel(t, 'codex', 'max')).toBe('Hoch · high')
    expect(effectiveEffortLabel(t, 'claude', undefined)).toBe('CLI-Standard')
    expect(effectiveEffortLabel(t, 'cursor', 'max')).toBe('CLI-Standard')
  })
})
