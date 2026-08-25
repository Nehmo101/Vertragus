import { describe, expect, it } from 'vitest'
import { PROVIDER_PRESET_IDS } from '@shared/schema/provider'
import {
  PI_HARNESS_COMMAND,
  PI_MCP_ADAPTER_EXTENSION,
  buildPiHarnessArgv,
  piProviderFor,
  piThinkingFor
} from './piHarness'

describe('piProviderFor', () => {
  it('maps each shipped preset onto a published Pi backend, and omits Ollama', () => {
    expect(piProviderFor('claude')).toBe('anthropic')
    expect(piProviderFor('codex')).toBe('openai-codex')
    expect(piProviderFor('kimi')).toBe('kimi-coding')
    expect(piProviderFor('cursor')).toBe('github-copilot')
    expect(piProviderFor('grok')).toBe('xai')
    expect(piProviderFor('ollama')).toBeUndefined()
  })

  it('omits --provider for custom slots and unknown ids', () => {
    expect(piProviderFor(undefined)).toBeUndefined()
    expect(piProviderFor('custom')).toBeUndefined()
    expect(piProviderFor('pi')).toBeUndefined()
  })

  it('covers every shipped preset id so a seventh preset cannot slip through unmapped', () => {
    expect(PROVIDER_PRESET_IDS).not.toContain('pi')
    const mapped = PROVIDER_PRESET_IDS.map((id) => [id, piProviderFor(id)] as const)
    expect(mapped).toEqual([
      ['claude', 'anthropic'],
      ['codex', 'openai-codex'],
      ['kimi', 'kimi-coding'],
      ['cursor', 'github-copilot'],
      ['grok', 'xai'],
      ['ollama', undefined]
    ])
  })
})

describe('piThinkingFor', () => {
  it('passes low/medium/high through and omits an empty effort', () => {
    expect(piThinkingFor('low')).toBe('low')
    expect(piThinkingFor('medium')).toBe('medium')
    expect(piThinkingFor('high')).toBe('high')
    expect(piThinkingFor(undefined)).toBeUndefined()
  })
})

describe('buildPiHarnessArgv', () => {
  it('loads only the MCP adapter, trusts project files, and does not save a session', () => {
    expect(buildPiHarnessArgv({})).toEqual([
      '--no-session',
      '--approve',
      '--no-extensions',
      '-e',
      PI_MCP_ADAPTER_EXTENSION
    ])
    expect(PI_HARNESS_COMMAND).toBe('pi')
  })

  it('composes a Claude-slot wrap: anthropic + model + thinking + system prompt', () => {
    expect(
      buildPiHarnessArgv({
        presetId: 'claude',
        model: 'opus',
        effort: 'high',
        systemPrompt: 'You orchestrate.',
        initialPrompt: 'Fix the login bug'
      })
    ).toEqual([
      '--no-session',
      '--approve',
      '--no-extensions',
      '-e',
      PI_MCP_ADAPTER_EXTENSION,
      '--provider',
      'anthropic',
      '--model',
      'opus',
      '--thinking',
      'high',
      '--append-system-prompt',
      'You orchestrate.',
      'Fix the login bug'
    ])
  })

  it('does not pass Ollama provider.args leftovers — omit --provider, keep --model', () => {
    const argv = buildPiHarnessArgv({ presetId: 'ollama', model: 'qwen3:32b' })
    expect(argv).not.toContain('--provider')
    expect(argv).not.toContain('run')
    expect(argv).not.toContain('--nowordwrap')
    expect(argv).toEqual([
      '--no-session',
      '--approve',
      '--no-extensions',
      '-e',
      PI_MCP_ADAPTER_EXTENSION,
      '--model',
      'qwen3:32b'
    ])
  })

  it('does not forward native yolo flags — Pi has no permission prompts', () => {
    const argv = buildPiHarnessArgv({ presetId: 'claude' })
    expect(argv.join(' ')).not.toMatch(/yolo|dangerously|always-approve/)
  })

  it('trims blank model / prompt so Pi does not see empty flags', () => {
    expect(buildPiHarnessArgv({ model: '  ', systemPrompt: '  ', initialPrompt: '' })).toEqual([
      '--no-session',
      '--approve',
      '--no-extensions',
      '-e',
      PI_MCP_ADAPTER_EXTENSION
    ])
  })
})
