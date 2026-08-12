import { describe, expect, it } from 'vitest'
import { providerConfigSchema, type ProviderConfig } from '@shared/schema/provider'
import { providerPreset, providerPresets } from './presets'

function preset(id: string): ProviderConfig {
  const found = providerPresets().find((entry) => entry.id === id)
  if (!found) throw new Error(`missing preset ${id}`)
  return found
}

describe('providerPresets', () => {
  it('ships the five built-ins, each carrying its preset id', () => {
    const presets = providerPresets()
    expect(presets.map((entry) => entry.id)).toEqual(['claude', 'codex', 'kimi', 'cursor', 'ollama'])
    for (const entry of presets) expect(entry.presetId).toBe(entry.id)
  })

  it('validates against the one provider schema', () => {
    for (const entry of providerPresets()) {
      expect(providerConfigSchema.safeParse(entry).success).toBe(true)
    }
  })

  it('hands out copies so a caller cannot poison the registry', () => {
    const first = providerPresets()[0]!
    first.command = 'tampered'
    first.yoloArgs.push('--nope')
    expect(providerPresets()[0]!.command).toBe('claude')
    expect(providerPresets()[0]!.yoloArgs).toEqual(['--dangerously-skip-permissions'])
  })

  it('resolves a single preset by id and nothing for an unknown one', () => {
    expect(providerPreset('codex')?.command).toBe('codex')
    expect(providerPreset('copilot')).toBeUndefined()
  })

  it('probes every provider with --version', () => {
    for (const entry of providerPresets()) expect(entry.versionArgs).toEqual(['--version'])
  })

  /**
   * The one rule that keeps the pickers honest: no preset may ship a versioned
   * model id. Only rolling aliases (no digit at all) are allowed as seeds —
   * anything else would be the hard-coded catalogue this design exists to avoid.
   */
  it('seeds rolling aliases only — never a versioned model id', () => {
    for (const entry of providerPresets()) {
      for (const seed of entry.seedModels) expect(seed).not.toMatch(/\d/)
    }
  })

  it('leaves every other preset seedless — their sources are wide enough', () => {
    for (const entry of providerPresets()) {
      if (entry.id !== 'claude') expect(entry.seedModels).toEqual([])
    }
  })
})

describe('claude preset', () => {
  const claude = preset('claude')

  it('carries the verified launch flags', () => {
    expect(claude.command).toBe('claude')
    expect(claude.yoloArgs).toEqual(['--dangerously-skip-permissions'])
    expect(claude.modelArg).toBe('--model')
    expect(claude.effortArg).toEqual({ style: 'flag', flag: '--effort' })
    expect(claude.systemPromptDelivery).toEqual({
      kind: 'arg',
      flag: '--append-system-prompt'
    })
  })

  it('attaches MCP through a transient, strict config file', () => {
    expect(claude.mcp).toEqual({
      kind: 'claude-json',
      configArg: '--mcp-config',
      strictArg: '--strict-mcp-config',
      allowedToolsArg: '--allowedTools'
    })
  })

  it('discovers models from the local account cache only — never an API key', () => {
    expect(claude.modelDiscovery).toEqual({
      kind: 'file',
      path: '~/.claude.json',
      parse: 'json',
      jsonPath: 'additionalModelOptionsCache[].value'
    })
  })

  it('knows the real login and status commands', () => {
    expect(claude.auth).toEqual({ loginArgs: ['auth', 'login'], statusArgs: ['auth', 'status'] })
  })

  /**
   * The account cache holds the ADDITIONAL options only, so a machine with an
   * empty modelAccessCache gets a one-entry picker. The seeds close that gap
   * without becoming a catalogue: every one of them is a rolling alias the CLI
   * resolves server-side, so none can name an outdated release.
   */
  it('seeds the three rolling CLI aliases — and nothing versioned', () => {
    expect(claude.seedModels).toEqual(['opus', 'sonnet', 'haiku'])
    for (const seed of claude.seedModels) expect(seed).toMatch(/^[a-z]+$/)
  })
})

describe('codex preset', () => {
  const codex = preset('codex')

  it('uses the bypass flag and the config-override effort surface', () => {
    expect(codex.yoloArgs).toEqual(['--dangerously-bypass-approvals-and-sandbox'])
    expect(codex.effortArg).toEqual({
      style: 'template',
      flag: '-c',
      template: 'model_reasoning_effort="{effort}"'
    })
  })

  it('keeps the distinct OpenAI attach surface (no Anthropic flags)', () => {
    expect(codex.systemPromptDelivery).toEqual({ kind: 'codex-config' })
    expect(codex.mcp).toEqual({ kind: 'codex-overrides' })
  })

  it('reads the account catalogue cache', () => {
    expect(codex.modelDiscovery).toMatchObject({
      kind: 'file',
      path: '~/.codex/models_cache.json',
      jsonPath: 'models[].slug'
    })
    expect(codex.auth?.statusArgs).toEqual(['login', 'status'])
  })
})

describe('kimi preset', () => {
  const kimi = preset('kimi')

  it('delivers the system prompt as an agent file and MCP per project', () => {
    expect(kimi.yoloArgs).toEqual(['--yolo'])
    expect(kimi.systemPromptDelivery).toEqual({ kind: 'agent-file', flag: '--agent-file' })
    expect(kimi.mcp).toEqual({ kind: 'kimi-project' })
  })

  it('declares no effort flag — the CLI has none, and an unknown flag kills a launch', () => {
    expect(kimi.effortArg).toBeUndefined()
  })

  it('lists models via the provider table of the CLI', () => {
    expect(kimi.modelDiscovery).toEqual({
      kind: 'cli',
      args: ['provider', 'list', '--json'],
      parse: 'json',
      jsonPath: 'models'
    })
  })

  it('has a login flow but no status probe', () => {
    expect(kimi.auth).toEqual({ loginArgs: ['login'] })
  })
})

describe('cursor preset', () => {
  const cursor = preset('cursor')

  it('attaches via project mcp.json and keeps the prompt on the PTY', () => {
    expect(cursor.command).toBe('cursor-agent')
    expect(cursor.args).toEqual(['--trust'])
    expect(cursor.yoloArgs).toEqual(['--yolo'])
    expect(cursor.systemPromptDelivery).toEqual({ kind: 'pty' })
    expect(cursor.mcp).toEqual({ kind: 'cursor-project' })
    // Multi-KB PTY paste: cursor-agent freezes while digesting, swallows an
    // early Enter but still redraws once — so acceptance needs sustained
    // output, not a mere buffer change. And the block must arrive as a paste
    // rather than as a keystroke stream whose newlines the PTY chunking can
    // turn into Enters. See interactiveReady + preset comment.
    expect(cursor.seed).toEqual({
      submitDelayMs: 750,
      submitRetries: 3,
      submitWatchMs: 2500,
      submitAcceptance: 'sustained-activity',
      bracketedPaste: 'auto'
    })
  })

  it('reads the line-based model list of the CLI', () => {
    expect(cursor.modelDiscovery).toEqual({ kind: 'cli', args: ['models'], parse: 'lines' })
    expect(cursor.auth?.statusArgs).toEqual(['status'])
  })
})

describe('ollama preset', () => {
  const ollama = preset('ollama')

  it('has no permission layer to bypass and takes the model positionally', () => {
    expect(ollama.yoloArgs).toEqual([])
    expect(ollama.args).toEqual(['run', '--nowordwrap'])
    expect(ollama.modelArg).toBeUndefined()
  })

  it('asks the local service which models physically exist', () => {
    expect(ollama.modelDiscovery).toEqual({
      kind: 'http',
      url: 'http://127.0.0.1:11434/api/tags',
      jsonPath: 'models[].name'
    })
  })
})
