import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildClaudeOrchestratorArgs,
  buildClaudeSubagentArgs,
  buildCodexOrchestratorArgs,
  buildCodexSubagentArgs,
  buildKimiOrchestratorArgs,
  buildKimiSubagentArgs,
  orchestratorAllowedTools
} from '@main/mcp/attach'
import { ORCHESTRATOR_TOOL_NAMES } from '@main/mcp/toolsOrchestrator'
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
/** A real directory: the Kimi attach path writes into the agent's cwd. */
let cwd: string

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), 'vertragus-spawn-'))
})

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'vertragus-spawn-cwd-'))
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

/** Replace transient file paths so expectations stay machine-independent. */
function normalize(argv: string[]): string[] {
  return argv.map((arg) => {
    if (!arg.startsWith(configDir)) return arg
    return arg.endsWith('.agent.md') ? '<agent-file.md>' : '<mcp-config.json>'
  })
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

  it('composes a Cursor subagent: trust, yolo, approve-mcps, prompt through the terminal', () => {
    const { argv, ptySystemPrompt } = buildAgentArgv(
      launchInput({
        provider: preset('cursor'),
        model: 'gpt-5.6',
        yolo: true,
        cwd,
        systemPrompt: 'You are a Reviewer.'
      })
    )

    expect(argv).toEqual(['--trust', '--model', 'gpt-5.6', '--yolo', '--approve-mcps'])
    expect(ptySystemPrompt).toBe('You are a Reviewer.')
    const written = JSON.parse(readFileSync(join(cwd, '.cursor', 'mcp.json'), 'utf8')) as {
      mcpServers: Record<string, { url: string }>
    }
    expect(written.mcpServers.vertragus!.url).toContain('agent=a1')
  })

  it('composes a Cursor orchestrator: trust + approve-mcps, no yolo', () => {
    const { argv, ptySystemPrompt } = buildAgentArgv(
      launchInput({
        provider: preset('cursor'),
        kind: 'orchestrator',
        yolo: true,
        cwd,
        systemPrompt: 'You orchestrate.'
      })
    )

    expect(argv).toEqual(['--trust', '--approve-mcps'])
    expect(argv).not.toContain('--yolo')
    // Prompt delivery stays PTY even though MCP is attached — orthogonal.
    expect(ptySystemPrompt).toBe('You orchestrate.')
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

  it('composes a Codex subagent: effort and attach are both -c overrides', () => {
    const { argv, ptySystemPrompt } = buildAgentArgv(
      launchInput({
        provider: preset('codex'),
        model: 'gpt-5.6',
        effort: 'high',
        yolo: true,
        systemPrompt: 'You are a Worker.'
      })
    )

    expect(argv).toEqual([
      '--model',
      'gpt-5.6',
      '-c',
      'model_reasoning_effort="high"',
      '--dangerously-bypass-approvals-and-sandbox',
      '-c',
      `mcp_servers.vertragus.url="${launchInput().mcpUrl}"`,
      '-c',
      'mcp_servers.vertragus.required=true',
      '-c',
      'mcp_servers.vertragus.default_tools_approval_mode="approve"',
      '-c',
      'developer_instructions="You are a Worker."'
    ])
    // Codex takes its prompt at launch; nothing is left for the terminal.
    expect(ptySystemPrompt).toBeUndefined()
  })

  it('composes a Codex orchestrator: enabled_tools instead of yolo', () => {
    const { argv } = buildAgentArgv(
      launchInput({
        provider: preset('codex'),
        kind: 'orchestrator',
        yolo: true,
        systemPrompt: 'You orchestrate.'
      })
    )

    expect(argv).toEqual([
      '-c',
      `mcp_servers.vertragus.url="${launchInput().mcpUrl}"`,
      '-c',
      'mcp_servers.vertragus.required=true',
      '-c',
      'mcp_servers.vertragus.default_tools_approval_mode="approve"',
      '-c',
      `mcp_servers.vertragus.enabled_tools=${JSON.stringify([...ORCHESTRATOR_TOOL_NAMES])}`,
      '-c',
      'developer_instructions="You orchestrate."'
    ])
    expect(argv).not.toContain('--dangerously-bypass-approvals-and-sandbox')
  })

  it('composes a Kimi subagent: a file in the cwd, a file for the prompt', () => {
    const { argv, ptySystemPrompt } = buildAgentArgv(
      launchInput({
        provider: preset('kimi'),
        model: 'kimi-code/k3',
        yolo: true,
        cwd,
        systemPrompt: 'You are a Worker.'
      })
    )

    expect(normalize(argv)).toEqual([
      '--model',
      'kimi-code/k3',
      '--yolo',
      '--agent-file',
      '<agent-file.md>'
    ])
    expect(ptySystemPrompt).toBeUndefined()

    // The attachment itself carries no flag — it is this file, and it names
    // THIS agent's URL.
    const written = JSON.parse(readFileSync(join(cwd, '.kimi-code', 'mcp.json'), 'utf8')) as {
      mcpServers: Record<string, { url: string; enabledTools?: string[] }>
    }
    expect(written.mcpServers.vertragus!.url).toContain('agent=a1')
    expect(written.mcpServers.vertragus!.enabledTools).toBeUndefined()
  })

  it('composes a Kimi orchestrator: scoped tools, no yolo', () => {
    const { argv } = buildAgentArgv(
      launchInput({
        provider: preset('kimi'),
        kind: 'orchestrator',
        yolo: true,
        cwd,
        systemPrompt: 'You orchestrate.'
      })
    )

    expect(normalize(argv)).toEqual(['--agent-file', '<agent-file.md>'])
    expect(argv).not.toContain('--yolo')
    const written = JSON.parse(readFileSync(join(cwd, '.kimi-code', 'mcp.json'), 'utf8')) as {
      mcpServers: Record<string, { enabledTools?: string[] }>
    }
    expect(written.mcpServers.vertragus!.enabledTools).toEqual([...ORCHESTRATOR_TOOL_NAMES])
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
    const url = launchInput().mcpUrl
    const target = { url, configDir, fileTag: 'drift' }
    const prompt = 'Delegate.'

    // One row per dialect: the descriptor-driven route (buildAgentArgv) and the
    // hand-written route in mcp/attach must stay byte-identical, or a preset
    // edit silently produces a launch nobody tested.
    const cases = [
      {
        provider: preset('claude'),
        orchestrator: buildClaudeOrchestratorArgs({ ...target, systemPrompt: prompt }),
        subagent: buildClaudeSubagentArgs({ ...target, systemPrompt: prompt })
      },
      {
        provider: preset('codex'),
        orchestrator: buildCodexOrchestratorArgs({ ...target, systemPrompt: prompt }),
        subagent: buildCodexSubagentArgs({ ...target, systemPrompt: prompt })
      },
      {
        provider: preset('kimi'),
        orchestrator: buildKimiOrchestratorArgs({
          ...target,
          workspaceDir: cwd,
          systemPrompt: prompt
        }),
        subagent: buildKimiSubagentArgs({ ...target, workspaceDir: cwd, systemPrompt: prompt })
      }
    ]

    for (const { provider, orchestrator, subagent } of cases) {
      for (const [kind, expected] of [
        ['orchestrator', orchestrator],
        ['subagent', subagent]
      ] as const) {
        const built = buildAgentArgv(
          launchInput({ provider, kind, cwd, fileTag: 'drift', systemPrompt: prompt })
        )
        // Only the attach + prompt tail is comparable; the head is model/effort.
        const tail = built.argv.slice(built.argv.length - expected.length)
        expect(normalize(tail), `${provider.id} ${kind}`).toEqual(normalize(expected))
      }
    }
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
    const { argv } = buildAgentArgv(launchInput({ provider: preset('ollama'), model: 'qwen3:32b' }))
    expect(argv).toEqual(['run', 'qwen3:32b'])
  })

  /**
   * The exact old-repo regression, restated per dialect: a subagent whose
   * launch does not carry its personal URL cannot report back, and looks
   * identical to one that is merely slow.
   */
  it('puts THIS agent’s server URL into every attaching subagent launch', () => {
    for (const provider of providerPresets()) {
      if (provider.mcp.kind === 'none') continue
      const { argv } = buildAgentArgv(
        launchInput({ provider, kind: 'subagent', cwd, systemPrompt: 'role' })
      )
      const urlSource =
        provider.mcp.kind === 'kimi-project' || provider.mcp.kind === 'cursor-project'
          ? // Project-file dialects: the URL lives in the cwd, not in argv.
            readFileSync(
              join(
                cwd,
                provider.mcp.kind === 'kimi-project' ? '.kimi-code' : '.cursor',
                'mcp.json'
              ),
              'utf8'
            )
          : provider.mcp.kind === 'claude-json'
            ? readFileSync(argv[argv.indexOf(provider.mcp.configArg) + 1]!, 'utf8')
            : argv.join(' ')
      expect(urlSource, `${provider.id} must carry the agent URL`).toContain('agent=a1')
    }
  })

  it('keeps the orchestrator prompt off the terminal for flag/file attaching presets', () => {
    for (const provider of providerPresets()) {
      if (provider.mcp.kind === 'none') continue
      const { ptySystemPrompt } = buildAgentArgv(
        launchInput({ provider, kind: 'orchestrator', cwd, systemPrompt: 'You orchestrate.' })
      )
      // Cursor attaches via a project file but still delivers its prompt through
      // the terminal — MCP attach and prompt delivery are orthogonal.
      if (provider.systemPromptDelivery.kind === 'pty') {
        expect(ptySystemPrompt, `${provider.id}`).toBe('You orchestrate.')
        continue
      }
      // A CLI that takes the prompt at launch leaves nothing for the seed path.
      expect(ptySystemPrompt, `${provider.id}`).toBeUndefined()
    }
  })

  it('writes Kimi’s project config into the worktree, never into the shared repo', () => {
    const worktree = mkdtempSync(join(tmpdir(), 'vertragus-spawn-wt-'))
    try {
      buildAgentArgv(launchInput({ provider: preset('kimi'), cwd: worktree }))
      expect(existsSync(join(worktree, '.kimi-code', 'mcp.json'))).toBe(true)
      expect(existsSync(join(cwd, '.kimi-code', 'mcp.json'))).toBe(false)
    } finally {
      rmSync(worktree, { recursive: true, force: true })
    }
  })
})

describe('yolo', () => {
  it('never reaches an orchestrator, whatever the provider or the flag says', () => {
    for (const provider of providerPresets()) {
      const { argv } = buildAgentArgv(
        launchInput({ provider, kind: 'orchestrator', yolo: true, model: 'm', cwd })
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

  it('pre-accepts the trust dialog for the exact directory it launches in', async () => {
    const ensureTrust = vi.fn()
    const worktree = '/repo/.vertragus/worktrees/a1'

    await spawnAgent(launchInput({ cwd: worktree }), {
      resolve,
      createPty: () => new FakePty(),
      ensureTrust
    })
    await spawnAgent(launchInput({ kind: 'orchestrator', cwd: '/repo' }), {
      resolve,
      createPty: () => new FakePty(),
      ensureTrust
    })

    // Orchestrator AND subagent, worktree paths included: the trust prompt is
    // modal inside the CLI, so any uncovered path is a silently hung agent.
    expect(ensureTrust.mock.calls.map((call) => call[0])).toEqual([worktree, '/repo'])
  })

  it('does not write Claude state for a CLI that is not the Claude preset', async () => {
    const ensureTrust = vi.fn()
    for (const id of ['cursor', 'ollama']) {
      await spawnAgent(launchInput({ provider: preset(id) }), {
        resolve,
        createPty: () => new FakePty(),
        ensureTrust
      })
    }
    expect(ensureTrust).not.toHaveBeenCalled()

    // Not even for a custom CLI that happens to be called "claude": without a
    // presetId we do not know that it keeps its answer in ~/.claude.json.
    const lookalike = providerConfigSchema.parse({
      id: 'my-claude',
      label: 'My Claude',
      command: 'claude'
    })
    await spawnAgent(launchInput({ provider: lookalike }), {
      resolve,
      createPty: () => new FakePty(),
      ensureTrust
    })
    expect(ensureTrust).not.toHaveBeenCalled()
  })

  it('starts the agent anyway when trust pre-acceptance blows up', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const pty = new FakePty()
    await spawnAgent(launchInput(), {
      resolve,
      createPty: () => pty,
      ensureTrust: () => {
        throw new Error('EPERM')
      }
    })
    expect(pty.spawnOptions).toBeDefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
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
