import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  buildClaudeOrchestratorArgs,
  buildClaudeSubagentArgs,
  orchestratorAllowedTools
} from '@main/mcp/attach'
import { providerPreset, providerPresets } from '@main/providers/presets'
import { providerConfigSchema, type ProviderConfig } from '@shared/schema/provider'
import {
  buildAgentArgv,
  buildAgentLaunch,
  needsFaithfulArgs,
  spawnAgent,
  type AgentLaunchInput,
  type AgentPty
} from './spawn'
import type { PtySpawnOptions } from './PtyAgent'
import type { ResolveLaunchOptions } from './resolveCommand'

let configDir: string

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), 'vertragus-spawn-'))
})

afterAll(() => {
  rmSync(configDir, { recursive: true, force: true })
})

function preset(id: string): ProviderConfig {
  const config = providerPreset(id)
  if (!config) throw new Error(`missing preset ${id}`)
  return config
}

function launchInput(overrides: Partial<AgentLaunchInput> = {}): AgentLaunchInput {
  return {
    kind: 'subagent',
    provider: preset('claude'),
    cwd: '/repo',
    mcpUrl: 'http://127.0.0.1:4711/mcp?ws=w1&agent=a1&token=sub',
    fileTag: 'sub-a1',
    configDir,
    ...overrides
  }
}

/** Replace the transient config path so expectations stay machine-independent. */
function normalize(argv: string[]): string[] {
  return argv.map((arg) => (arg.startsWith(configDir) ? '<mcp-config.json>' : arg))
}

describe('buildAgentArgv — per preset', () => {
  it('composes a Claude subagent: model, effort, yolo, attach, role prompt', () => {
    const { argv, ptySystemPrompt } = buildAgentArgv(
      launchInput({
        model: 'opus',
        effort: 'high',
        yolo: true,
        systemPrompt: 'You are a Worker.'
      })
    )

    expect(normalize(argv)).toEqual([
      '--model',
      'opus',
      '--effort',
      'high',
      '--dangerously-skip-permissions',
      '--mcp-config',
      '<mcp-config.json>',
      '--strict-mcp-config',
      '--append-system-prompt',
      'You are a Worker.'
    ])
    // A flag-delivered prompt leaves nothing for the terminal.
    expect(ptySystemPrompt).toBeUndefined()
  })

  it('composes a Claude orchestrator: allowlist instead of yolo', () => {
    const { argv } = buildAgentArgv(
      launchInput({
        kind: 'orchestrator',
        mcpUrl: 'http://127.0.0.1:4711/mcp?ws=w1&token=orch',
        fileTag: 'orch-a0',
        yolo: true,
        systemPrompt: 'You are the orchestrator.'
      })
    )

    expect(normalize(argv)).toEqual([
      '--mcp-config',
      '<mcp-config.json>',
      '--strict-mcp-config',
      '--allowedTools',
      orchestratorAllowedTools().join(','),
      '--append-system-prompt',
      'You are the orchestrator.'
    ])
  })

  it('composes a Cursor subagent: yolo, no attach, prompt through the terminal', () => {
    const { argv, ptySystemPrompt } = buildAgentArgv(
      launchInput({
        provider: preset('cursor'),
        model: 'gpt-5.6',
        yolo: true,
        systemPrompt: 'You are a Reviewer.'
      })
    )

    expect(argv).toEqual(['--model', 'gpt-5.6', '--yolo'])
    expect(ptySystemPrompt).toBe('You are a Reviewer.')
  })

  it('gives Ollama its model positionally, right behind the base args', () => {
    const { argv, ptySystemPrompt } = buildAgentArgv(
      launchInput({
        provider: preset('ollama'),
        model: 'qwen3:32b',
        yolo: true,
        systemPrompt: 'You are a Worker.'
      })
    )

    // `ollama run <model>` — a --model flag here would be a launch failure.
    expect(argv).toEqual(['run', 'qwen3:32b'])
    expect(ptySystemPrompt).toBe('You are a Worker.')
  })

  it('refuses Codex and Kimi with an explicit M5 error instead of a broken launch', () => {
    expect(() => buildAgentArgv(launchInput({ provider: preset('codex'), model: 'gpt-5.6' })))
      .toThrowError(/M5/)
    expect(() => buildAgentArgv(launchInput({ provider: preset('kimi'), model: 'k2' })))
      .toThrowError(/M5/)
  })

  it('omits model and effort args when the launch does not set them', () => {
    const { argv } = buildAgentArgv(launchInput({ yolo: false }))
    expect(normalize(argv)).toEqual(['--mcp-config', '<mcp-config.json>', '--strict-mcp-config'])
  })
})

describe('MCP attach — the regression that killed the old repo', () => {
  it('attaches the MCP config to EVERY claude-json subagent launch', () => {
    for (const provider of providerPresets()) {
      if (provider.mcp.kind !== 'claude-json') continue
      const { argv } = buildAgentArgv(
        launchInput({ provider, kind: 'subagent', systemPrompt: 'role' })
      )
      const index = argv.indexOf(provider.mcp.configArg)
      expect(index, `${provider.id} must attach MCP`).toBeGreaterThanOrEqual(0)

      // Not just the flag: the file has to exist and name this agent's URL.
      const written = JSON.parse(readFileSync(argv[index + 1]!, 'utf8')) as {
        mcpServers: Record<string, { url: string }>
      }
      expect(written.mcpServers.vertragus.url).toContain('agent=a1')
    }
  })

  it('produces exactly the args mcp/attach builds, so the two cannot drift', () => {
    const claude = preset('claude')
    const target = { url: 'http://127.0.0.1:4711/mcp?ws=w1', configDir, fileTag: 'drift' }

    const orchestrator = buildAgentArgv(
      launchInput({ provider: claude, kind: 'orchestrator', fileTag: 'drift' })
    )
    expect(normalize(orchestrator.argv)).toEqual(
      normalize(buildClaudeOrchestratorArgs({ ...target, url: launchInput().mcpUrl }))
    )

    const subagent = buildAgentArgv(
      launchInput({ provider: claude, kind: 'subagent', fileTag: 'drift' })
    )
    expect(normalize(subagent.argv)).toEqual(
      normalize(buildClaudeSubagentArgs({ ...target, url: launchInput().mcpUrl }))
    )
  })

  it('honours the flags a custom claude-json provider declares', () => {
    const custom = providerConfigSchema.parse({
      id: 'custom-claude',
      label: 'Custom',
      command: 'myclaude',
      mcp: { kind: 'claude-json', configArg: '--mcp', strictArg: '--only-mcp', allowedToolsArg: '--tools' }
    })
    const { argv } = buildAgentArgv(launchInput({ provider: custom, kind: 'orchestrator' }))
    expect(normalize(argv)).toEqual([
      '--mcp',
      '<mcp-config.json>',
      '--only-mcp',
      '--tools',
      orchestratorAllowedTools().join(',')
    ])
  })

  it('leaves an mcp: none provider unattached — a declaration, not an omission', () => {
    const { argv } = buildAgentArgv(launchInput({ provider: preset('cursor') }))
    expect(argv).toEqual([])
  })
})

describe('yolo', () => {
  it('never reaches an orchestrator, whatever the provider or the flag says', () => {
    for (const provider of providerPresets()) {
      if (provider.mcp.kind === 'codex-overrides' || provider.mcp.kind === 'kimi-project') continue
      const { argv } = buildAgentArgv(
        launchInput({ provider, kind: 'orchestrator', yolo: true, model: 'm' })
      )
      for (const flag of provider.yoloArgs) {
        expect(argv, `${provider.id} orchestrator must not be yolo`).not.toContain(flag)
      }
    }
  })

  it('is opt-in for subagents', () => {
    const off = buildAgentArgv(launchInput({ yolo: false })).argv
    const on = buildAgentArgv(launchInput({ yolo: true })).argv
    expect(off).not.toContain('--dangerously-skip-permissions')
    expect(on).toContain('--dangerously-skip-permissions')
  })
})

describe('buildAgentLaunch', () => {
  it('resolves the command instead of handing node-pty a bare name', async () => {
    const resolve = vi.fn(async (command: string, args: string[]) => ({
      file: `C:\\shims\\${command}.exe`,
      args
    }))
    const launch = await buildAgentLaunch(launchInput({ model: 'opus' }), { resolve })

    expect(resolve).toHaveBeenCalledWith('claude', launch.argv, expect.anything())
    expect(launch.file).toBe('C:\\shims\\claude.exe')
    expect(launch.command).toBe('claude')
    expect(launch.cwd).toBe('/repo')
  })

  it('demands an argument-faithful entrypoint for multiline prompts', async () => {
    const resolve = vi.fn(
      async (_c: string, args: string[], _o?: ResolveLaunchOptions) => ({ file: 'claude', args })
    )
    await buildAgentLaunch(launchInput({ systemPrompt: 'line one\nline two' }), { resolve })
    expect(resolve.mock.calls[0]![2]).toMatchObject({ requireFaithfulArgs: true })

    resolve.mockClear()
    await buildAgentLaunch(launchInput({ systemPrompt: 'single line' }), { resolve })
    expect(resolve.mock.calls[0]![2]).toMatchObject({ requireFaithfulArgs: false })
  })

  it('detects arguments a cmd.exe wrapper would truncate', () => {
    expect(needsFaithfulArgs(['--model', 'opus'])).toBe(false)
    expect(needsFaithfulArgs(['--prompt', 'a\nb'])).toBe(true)
    expect(needsFaithfulArgs(['--prompt', 'a\r\nb'])).toBe(true)
  })
})

class FakePty implements AgentPty {
  pid: number | undefined = 4242
  isAlive = true
  cols = 100
  rows = 30
  pushed: string[] = []
  spawnOptions: PtySpawnOptions | undefined
  spawnError: Error | undefined

  spawn(options: PtySpawnOptions): void {
    if (this.spawnError) throw this.spawnError
    this.spawnOptions = options
  }
  write(): void {}
  resize(): void {}
  onData(): () => void {
    return () => undefined
  }
  onExit(): () => void {
    return () => undefined
  }
  snapshot(): string {
    return this.pushed.join('')
  }
  tail(): string {
    return this.pushed.join('')
  }
  push(data: string): void {
    this.pushed.push(data)
  }
  kill(): void {}
  dispose(): void {}
}

describe('spawnAgent', () => {
  const resolve = async (_command: string, args: string[]): Promise<{ file: string; args: string[] }> => ({
    file: '/usr/bin/claude',
    args
  })

  it('spawns the resolved launch in the agent working directory', async () => {
    const pty = new FakePty()
    const { launch } = await spawnAgent(launchInput({ cwd: '/repo/.vertragus/worktrees/a1' }), {
      resolve,
      createPty: () => pty
    })

    expect(pty.spawnOptions).toMatchObject({
      file: '/usr/bin/claude',
      args: launch.args,
      cwd: '/repo/.vertragus/worktrees/a1'
    })
  })

  it('writes a spawn failure into the agent scrollback and rethrows it', async () => {
    const pty = new FakePty()
    pty.spawnError = new Error('spawn claude ENOENT')

    await expect(spawnAgent(launchInput(), { resolve, createPty: () => pty })).rejects.toThrow(
      'spawn claude ENOENT'
    )
    // The window and read_output show why the agent is dead.
    expect(pty.snapshot()).toContain('spawn claude ENOENT')
    expect(pty.snapshot()).toContain('claude')
  })
})
