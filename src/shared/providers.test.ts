import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MODELS,
  DEFAULT_PROVIDER_LIMITS,
  getProvider,
  normalizeProviderLimits,
  parseProviderLimits,
  providerHeadlessDef,
  providerResumeArgs,
  PROVIDERS
} from './providers'

describe('native conversation resume capability', () => {
  it('declares the cwd-scoped continue flag for Claude only', () => {
    expect(providerResumeArgs('claude')).toEqual(['--continue'])
    // Codex' `resume --last` is globally scoped — with parallel agents it could
    // reattach a foreign conversation, so it must stay undeclared.
    expect(providerResumeArgs('codex')).toBeUndefined()
    expect(providerResumeArgs('cursor')).toBeUndefined()
    expect(providerResumeArgs('copilot')).toBeUndefined()
    expect(providerResumeArgs('kimi')).toBeUndefined()
    expect(providerResumeArgs('ollama')).toBeUndefined()
  })
})

describe('headless capability descriptor (A8)', () => {
  it('captures the exact stream-format + verbose behavior headless.ts relied on', () => {
    // Anthropic-style stream-json: claude/kimi/cursor/copilot; codex + ollama own.
    expect(providerHeadlessDef('claude')).toEqual({ streamFormat: 'anthropic', verbose: true })
    expect(providerHeadlessDef('kimi')).toEqual({ streamFormat: 'anthropic', verbose: true })
    expect(providerHeadlessDef('cursor')?.streamFormat).toBe('anthropic')
    expect(providerHeadlessDef('copilot')?.streamFormat).toBe('anthropic')
    expect(providerHeadlessDef('codex')?.streamFormat).toBe('codex')
    expect(providerHeadlessDef('ollama')?.streamFormat).toBe('ollama')
    // Only Claude Code and the Kimi mirror pass --verbose.
    for (const id of ['cursor', 'copilot', 'codex', 'ollama'] as const) {
      expect(providerHeadlessDef(id)?.verbose ?? false).toBe(false)
    }
  })

  it('marks Ollama as the only locally-run agent provider', () => {
    expect(getProvider('ollama')?.runsLocally).toBe(true)
    for (const def of PROVIDERS) {
      if (def.id !== 'ollama') expect(def.runsLocally ?? false).toBe(false)
    }
  })

  it('gives every agent provider a headless descriptor', () => {
    for (const def of PROVIDERS) {
      if (def.kind === 'agent' || def.kind === 'llm') expect(def.headless).toBeDefined()
      if (def.kind === 'integration') expect(def.headless).toBeUndefined()
    }
  })
})

describe('model catalogue fallbacks', () => {
  it('keeps stable Claude aliases and useful Cursor fallback suggestions visible', () => {
    expect(DEFAULT_MODELS.claude).toEqual(
      expect.arrayContaining(['sonnet', 'opus', 'haiku', 'fable'])
    )
    expect(DEFAULT_MODELS.cursor).toEqual(
      expect.arrayContaining(['auto', 'composer-2.5', 'composer-2.5-fast'])
    )
  })

  it('uses canonical Codex CLI identifiers without obsolete aliases', () => {
    expect(DEFAULT_MODELS.codex).toEqual(
      expect.arrayContaining(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'])
    )
    expect(DEFAULT_MODELS.codex).not.toEqual(
      expect.arrayContaining(['gpt-5.6', 'gpt-5.6-codex'])
    )
  })

  it('exposes the curated Kimi K3/K2 model line', () => {
    expect(DEFAULT_MODELS.kimi).toEqual(
      expect.arrayContaining(['kimi-k3', 'kimi-k3-turbo', 'kimi-k3-thinking'])
    )
  })

  it('uses current standalone Copilot CLI model identifiers', () => {
    expect(DEFAULT_MODELS.copilot).toEqual(
      expect.arrayContaining([
        'auto',
        'claude-sonnet-4.6',
        'gpt-5.4',
        'claude-haiku-4.5',
        'gpt-5.3-codex'
      ])
    )
    expect(DEFAULT_MODELS.copilot).not.toContain('claude-sonnet-4.5')
  })
})

describe('provider gate limits', () => {
  it('uses finite defaults and accepts a configurable Claude gate', () => {
    expect(normalizeProviderLimits({ claude: 7 })).toEqual({
      ...DEFAULT_PROVIDER_LIMITS,
      claude: 7
    })
  })

  it('uses safe defaults for malformed persisted values', () => {
    expect(normalizeProviderLimits({ claude: -1, cursor: '4', codex: Number.NaN })).toEqual(
      DEFAULT_PROVIDER_LIMITS
    )
  })

  it('migrates the legacy 0 (unlimited) sentinel to the finite default', () => {
    expect(normalizeProviderLimits({ claude: 0, codex: 0 })).toEqual(DEFAULT_PROVIDER_LIMITS)
  })

  it('rejects unsafe renderer updates', () => {
    expect(parseProviderLimits({ cursor: 17 }).cursor).toBe(17)
    expect(() => parseProviderLimits({ cursor: 0 })).toThrow(/zwischen 1 und/)
    expect(() => parseProviderLimits({ cursor: -1 })).toThrow(/zwischen 1 und/)
    expect(() => parseProviderLimits({ cursor: 100 })).toThrow(/zwischen 1 und/)
    expect(() => parseProviderLimits({ claude: 1.5 })).toThrow(/ganze Zahl/)
    expect(() => parseProviderLimits({ quota: 4 })).toThrow(/Unbekanntes Vertragus-Gate/)
  })
})
