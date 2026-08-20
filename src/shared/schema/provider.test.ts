import { describe, expect, it } from 'vitest'
import {
  buildEffortArgs,
  buildModelArgs,
  mergeProviderConfigs,
  modelMemorySchema,
  normalizeProviderId,
  parseProviderConfigs,
  providerConfigSchema,
  type ProviderConfig
} from './provider'

const minimal = { id: 'acme', label: 'Acme CLI', command: 'acme' }

function config(overrides: Record<string, unknown> = {}): ProviderConfig {
  return providerConfigSchema.parse({ ...minimal, ...overrides })
}

describe('providerConfigSchema', () => {
  it('fills the safe defaults for a minimal descriptor', () => {
    const parsed = config()
    expect(parsed).toMatchObject({
      args: [],
      yoloArgs: [],
      versionArgs: ['--version'],
      enabled: true,
      systemPromptDelivery: { kind: 'pty' },
      mcp: { kind: 'none' },
      modelDiscovery: { kind: 'none' },
      seedModels: []
    })
  })

  it('accepts declared seed models and trims them', () => {
    expect(config({ seedModels: [' opus ', 'sonnet'] }).seedModels).toEqual(['opus', 'sonnet'])
  })

  it('rejects a blank seed instead of offering an unpickable empty row', () => {
    expect(providerConfigSchema.safeParse({ ...minimal, seedModels: ['  '] }).success).toBe(false)
    expect(providerConfigSchema.safeParse({ ...minimal, seedModels: 'opus' }).success).toBe(false)
  })

  it('rejects an unknown field instead of silently keeping it (strict)', () => {
    expect(providerConfigSchema.safeParse({ ...minimal, promptDelivery: 'stdin' }).success).toBe(
      false
    )
  })

  it('rejects an empty command or label', () => {
    expect(providerConfigSchema.safeParse({ ...minimal, command: '  ' }).success).toBe(false)
    expect(providerConfigSchema.safeParse({ ...minimal, label: '' }).success).toBe(false)
  })

  it('accepts every system-prompt delivery mode and rejects an unknown one', () => {
    for (const delivery of [
      { kind: 'arg', flag: '--append-system-prompt' },
      { kind: 'agent-file', flag: '--agent-file' },
      { kind: 'codex-config' },
      { kind: 'pty' }
    ]) {
      expect(
        providerConfigSchema.safeParse({ ...minimal, systemPromptDelivery: delivery }).success
      ).toBe(true)
    }
    expect(
      providerConfigSchema.safeParse({ ...minimal, systemPromptDelivery: { kind: 'stdin' } }).success
    ).toBe(false)
  })

  it('requires the config flag on a claude-json MCP attach', () => {
    expect(providerConfigSchema.safeParse({ ...minimal, mcp: { kind: 'claude-json' } }).success).toBe(
      false
    )
    expect(
      providerConfigSchema.safeParse({
        ...minimal,
        mcp: { kind: 'claude-json', configArg: '--mcp-config' }
      }).success
    ).toBe(true)
  })

  it('accepts the project-file MCP dialects and rejects an unknown kind', () => {
    expect(
      providerConfigSchema.safeParse({ ...minimal, mcp: { kind: 'kimi-project' } }).success
    ).toBe(true)
    expect(
      providerConfigSchema.safeParse({ ...minimal, mcp: { kind: 'cursor-project' } }).success
    ).toBe(true)
    expect(
      providerConfigSchema.safeParse({ ...minimal, mcp: { kind: 'grok-project' } }).success
    ).toBe(true)
    expect(
      providerConfigSchema.safeParse({ ...minimal, mcp: { kind: 'cursor-json' } }).success
    ).toBe(false)
  })

  it('rejects an effort template without the {effort} placeholder', () => {
    expect(
      providerConfigSchema.safeParse({
        ...minimal,
        effortArg: { style: 'template', flag: '-c', template: 'model_reasoning_effort="high"' }
      }).success
    ).toBe(false)
  })

  it('requires a jsonPath for http discovery and a url that parses', () => {
    expect(
      providerConfigSchema.safeParse({
        ...minimal,
        modelDiscovery: { kind: 'http', url: 'not-a-url', jsonPath: 'models[].name' }
      }).success
    ).toBe(false)
    expect(
      providerConfigSchema.safeParse({
        ...minimal,
        modelDiscovery: { kind: 'http', url: 'http://127.0.0.1:11434/api/tags' }
      }).success
    ).toBe(false)
  })

  /**
   * The capability claim behind the long `await_events` poll. Absent means "the
   * CLI keeps its 60 s default" — so a zero, a fraction or an hour-plus value
   * must not parse into a claim nobody can honour.
   */
  it('accepts a raised MCP tool timeout as a bounded positive integer', () => {
    expect(config().mcpToolTimeoutSec).toBeUndefined()
    expect(config({ mcpToolTimeoutSec: 600 }).mcpToolTimeoutSec).toBe(600)
    expect(config({ mcpToolTimeoutSec: 3600 }).mcpToolTimeoutSec).toBe(3600)
    for (const value of [0, -1, 1.5, 3601, '600']) {
      expect(
        providerConfigSchema.safeParse({ ...minimal, mcpToolTimeoutSec: value }).success
      ).toBe(false)
    }
  })

  it('accepts optional seed-handshake overrides and rejects junk', () => {
    expect(
      providerConfigSchema.safeParse({ ...minimal, seed: { submitDelayMs: 750 } }).success
    ).toBe(true)
    expect(
      providerConfigSchema.safeParse({
        ...minimal,
        seed: { submitAcceptance: 'sustained-activity' }
      }).success
    ).toBe(true)
    expect(
      providerConfigSchema.safeParse({ ...minimal, seed: { submitAcceptance: 'buffer-change' } })
        .success
    ).toBe(true)
    expect(
      providerConfigSchema.safeParse({ ...minimal, seed: { bracketedPaste: 'auto' } }).success
    ).toBe(true)
    expect(
      providerConfigSchema.safeParse({ ...minimal, seed: { bracketedPaste: 'never' } }).success
    ).toBe(true)
    expect(
      providerConfigSchema.safeParse({ ...minimal, seed: { bracketedPaste: 'always' } }).success
    ).toBe(false)
    expect(
      providerConfigSchema.safeParse({ ...minimal, seed: { submitRetries: 0 } }).success
    ).toBe(false)
    expect(
      providerConfigSchema.safeParse({ ...minimal, seed: { submitAcceptance: 'always' } }).success
    ).toBe(false)
    expect(
      providerConfigSchema.safeParse({ ...minimal, seed: { unknown: true } }).success
    ).toBe(false)
  })
})

describe('normalizeProviderId', () => {
  it('lowercases and replaces everything outside the id alphabet', () => {
    expect(normalizeProviderId('  My Provider!  ')).toBe('my-provider')
    expect(normalizeProviderId('claude')).toBe('claude')
  })
})

describe('parseProviderConfigs', () => {
  it('drops invalid rows instead of failing the whole list', () => {
    const parsed = parseProviderConfigs([
      minimal,
      { id: 'broken' },
      { ...minimal, id: 'other', label: 'Other', extra: true },
      'nonsense'
    ])
    expect(parsed.map((entry) => entry.id)).toEqual(['acme'])
  })

  it('normalizes ids and keeps the first of a duplicate pair', () => {
    const parsed = parseProviderConfigs([
      { ...minimal, id: 'My CLI', label: 'first' },
      { ...minimal, id: 'my-cli', label: 'second' }
    ])
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toMatchObject({ id: 'my-cli', label: 'first' })
  })

  it('returns an empty list for a non-array value', () => {
    expect(parseProviderConfigs(undefined)).toEqual([])
    expect(parseProviderConfigs({ id: 'acme' })).toEqual([])
  })
})

describe('mergeProviderConfigs', () => {
  const presets = [
    config({ id: 'claude', presetId: 'claude', label: 'Claude Code', command: 'claude' }),
    config({ id: 'codex', presetId: 'codex', label: 'Codex', command: 'codex' })
  ]

  it('lets a stored entry override its preset in place', () => {
    const stored = [config({ id: 'claude', presetId: 'claude', label: 'Claude Code', command: 'claude', yoloArgs: [] })]
    const merged = mergeProviderConfigs(presets, stored)
    expect(merged.map((entry) => entry.id)).toEqual(['claude', 'codex'])
    expect(merged[0]).toBe(stored[0])
  })

  it('appends unknown stored ids as custom providers', () => {
    const merged = mergeProviderConfigs(presets, [config({ id: 'acme' })])
    expect(merged.map((entry) => entry.id)).toEqual(['claude', 'codex', 'acme'])
  })

  it('returns the presets untouched when nothing is stored', () => {
    expect(mergeProviderConfigs(presets, [])).toEqual(presets)
  })
})

describe('launch argument helpers', () => {
  it('uses the model flag when the provider declares one', () => {
    expect(buildModelArgs(config({ modelArg: '--model' }), 'opus')).toEqual(['--model', 'opus'])
  })

  it('passes the model positionally when there is no flag (ollama run <model>)', () => {
    expect(buildModelArgs(config(), 'qwen2.5-coder:32b')).toEqual(['qwen2.5-coder:32b'])
  })

  it('emits nothing for an empty model — the CLI default wins', () => {
    expect(buildModelArgs(config({ modelArg: '--model' }), '  ')).toEqual([])
    expect(buildModelArgs(config(), undefined)).toEqual([])
  })

  it('builds a plain effort flag and a templated config override', () => {
    expect(buildEffortArgs(config({ effortArg: { style: 'flag', flag: '--effort' } }), 'high')).toEqual([
      '--effort',
      'high'
    ])
    expect(
      buildEffortArgs(
        config({
          effortArg: { style: 'template', flag: '-c', template: 'model_reasoning_effort="{effort}"' }
        }),
        'low'
      )
    ).toEqual(['-c', 'model_reasoning_effort="low"'])
  })

  it('emits nothing when the provider has no effort surface', () => {
    expect(buildEffortArgs(config(), 'high')).toEqual([])
    expect(buildEffortArgs(config({ effortArg: { style: 'flag', flag: '--effort' } }), undefined)).toEqual(
      []
    )
  })
})

describe('modelMemorySchema', () => {
  it('accepts a provider→model→timestamp map and rejects junk', () => {
    expect(modelMemorySchema.safeParse({ claude: { opus: 1 } }).success).toBe(true)
    expect(modelMemorySchema.safeParse({ claude: { opus: 'yesterday' } }).success).toBe(false)
    expect(modelMemorySchema.safeParse([]).success).toBe(false)
  })
})
