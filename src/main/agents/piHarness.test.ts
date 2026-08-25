import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PROVIDER_PRESET_IDS } from '@shared/schema/provider'
import {
  PI_CODING_AGENT_PACKAGE,
  PI_HARNESS_COMMAND,
  PI_MCP_ADAPTER_EXTENSION,
  PI_MCP_ADAPTER_NPM_SPEC,
  PI_MCP_ADAPTER_PACKAGE,
  buildPiHarnessArgv,
  piHarnessEnv,
  piMcpAdapterExtension,
  piProviderFor,
  piThinkingFor,
  preferAsarUnpacked,
  resolvePiHarnessCli
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

describe('lockfile Pi CLI and adapter', () => {
  it('resolves the packaged bin.pi entry, not a PATH name', () => {
    const cli = resolvePiHarnessCli()
    expect(cli).toBeDefined()
    expect(cli).toMatch(/dist[/\\]cli\.js$/)
    expect(existsSync(cli!)).toBe(true)
    expect(PI_HARNESS_COMMAND).toBe('pi')
    expect(PI_CODING_AGENT_PACKAGE).toBe('@mariozechner/pi-coding-agent')
  })

  it('pins the adapter to the installed version and prefers the lockfile copy', () => {
    expect(PI_MCP_ADAPTER_PACKAGE).toBe('pi-mcp-adapter')
    expect(PI_MCP_ADAPTER_NPM_SPEC).toMatch(/^npm:pi-mcp-adapter@\d+\.\d+\.\d+/)
    expect(piMcpAdapterExtension()).toBe(PI_MCP_ADAPTER_EXTENSION)
    expect(existsSync(PI_MCP_ADAPTER_EXTENSION)).toBe(true)
    expect(PI_MCP_ADAPTER_EXTENSION).not.toMatch(/^npm:/)
  })

  it('only sets ELECTRON_RUN_AS_NODE when a bundled CLI path exists', () => {
    expect(piHarnessEnv(undefined)).toBeUndefined()
    expect(piHarnessEnv('/tmp/pi/dist/cli.js')).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
  })

  it('rewrites app.asar to app.asar.unpacked when that copy exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'vertragus-asar-'))
    const asarFile = join(root, 'app.asar', 'node_modules', 'pkg', 'cli.js')
    const unpackedFile = join(root, 'app.asar.unpacked', 'node_modules', 'pkg', 'cli.js')
    mkdirSync(join(root, 'app.asar', 'node_modules', 'pkg'), { recursive: true })
    mkdirSync(join(root, 'app.asar.unpacked', 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(unpackedFile, 'unpacked\n')
    expect(preferAsarUnpacked(asarFile)).toBe(unpackedFile)
    expect(preferAsarUnpacked(unpackedFile)).toBe(unpackedFile)
    expect(preferAsarUnpacked(join(root, 'plain', 'cli.js'))).toBe(join(root, 'plain', 'cli.js'))
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
