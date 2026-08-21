import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildClaudeOrchestratorArgs,
  buildClaudeSubagentArgs,
  buildCodexOrchestratorArgs,
  buildCodexSubagentArgs,
  buildGrokOrchestratorArgs,
  buildGrokSubagentArgs,
  buildKimiOrchestratorArgs,
  buildKimiSubagentArgs,
  grokAllowMcpArgs,
  orchestratorAllowedTools
} from '@main/mcp/attach'
import { ORCHESTRATOR_TOOL_NAMES } from '@main/mcp/toolsOrchestrator'
import { providerPreset, providerPresets } from '@main/providers/presets'
import { extraMcpServerSchema } from '@shared/schema/mcpServer'
import { providerConfigSchema, type ProviderConfig } from '@shared/schema/provider'
import {
  buildAgentArgv,
  buildAgentEnv,
  buildAgentLaunch,
  needsFaithfulArgs,
  spawnAgent,
  type AgentLaunchInput,
  type AgentPty
} from './spawn'
import type { PtySpawnOptions } from './PtyAgent'
import type { ResolveLaunchOptions } from './resolveCommand'

let configDir: string
/**
 * A real directory: the Kimi and Cursor attach paths write into the agent's
 * cwd. Any case that touches one of them must pass this `cwd` — the fixture
 * default (`/repo`) does not exist, and on a CI runner the write fails with
 * EACCES (Linux, unwritable `/`) or ENOENT (macOS, read-only `/`).
 */
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

    // `ollama run --nowordwrap <model>` — a --model flag here would be a launch failure.
    expect(argv).toEqual(['run', '--nowordwrap', 'qwen3:32b'])
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

  /**
   * The Codex half of the long-poll lever, opt-in as DATA: the preset makes no
   * claim (unknown `mcp_servers.*` keys are unverified on older builds), but a
   * user or a custom provider that sets the field gets the override — and no
   * environment, because Codex takes its settings as arguments.
   */
  it('passes a declared tool timeout to Codex as one more -c override', () => {
    const codex = { ...preset('codex'), mcpToolTimeoutSec: 600 }
    const { argv } = buildAgentArgv(launchInput({ provider: codex, kind: 'orchestrator' }))
    expect(argv).toContain('mcp_servers.vertragus.tool_timeout_sec=600')
    expect(buildAgentEnv(launchInput({ provider: codex }))).toBeUndefined()

    // And nothing at all when the preset is left as shipped.
    const { argv: plain } = buildAgentArgv(launchInput({ provider: preset('codex') }))
    expect(plain.some((arg) => arg.includes('tool_timeout_sec'))).toBe(false)
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

  it('composes a Grok subagent: model, effort, yolo, project file, role prompt', () => {
    const { argv, ptySystemPrompt } = buildAgentArgv(
      launchInput({
        provider: preset('grok'),
        model: 'grok-build',
        effort: 'high',
        yolo: true,
        cwd,
        systemPrompt: 'You are a Worker.'
      })
    )

    expect(argv).toEqual([
      '--model',
      'grok-build',
      '--effort',
      'high',
      '--always-approve',
      ...grokAllowMcpArgs(),
      '--append-system-prompt',
      'You are a Worker.'
    ])
    expect(ptySystemPrompt).toBeUndefined()
    const written = readFileSync(join(cwd, '.grok', 'config.toml'), 'utf8')
    expect(written).toContain('[mcp_servers.vertragus]')
    expect(written).toContain('agent=a1')
  })

  it('composes a Grok orchestrator: allow MCP tools instead of yolo', () => {
    const { argv } = buildAgentArgv(
      launchInput({
        provider: preset('grok'),
        kind: 'orchestrator',
        yolo: true,
        cwd,
        systemPrompt: 'You orchestrate.'
      })
    )

    expect(argv).toEqual([
      ...grokAllowMcpArgs(),
      '--append-system-prompt',
      'You orchestrate.'
    ])
    expect(argv).not.toContain('--always-approve')
  })

  it('appends a grok start-goal as a trailing positional, never -p/--single', () => {
    const { argv, ptySystemPrompt } = buildAgentArgv(
      launchInput({
        provider: preset('grok'),
        kind: 'orchestrator',
        cwd,
        systemPrompt: 'You orchestrate.',
        initialPrompt: '  Fix the login bug  '
      })
    )

    expect(argv.at(-1)).toBe('Fix the login bug')
    expect(argv).toEqual([
      ...grokAllowMcpArgs(),
      '--append-system-prompt',
      'You orchestrate.',
      'Fix the login bug'
    ])
    expect(argv).not.toContain('-p')
    expect(argv).not.toContain('--single')
    expect(argv).not.toContain('--max-turns')
    expect(ptySystemPrompt).toBeUndefined()
  })

  it('omits a positional first prompt when the goal is blank or the provider has no surface', () => {
    const grokBare = buildAgentArgv(
      launchInput({
        provider: preset('grok'),
        kind: 'orchestrator',
        cwd,
        systemPrompt: 'You orchestrate.',
        initialPrompt: '   '
      })
    ).argv
    expect(grokBare.at(-1)).toBe('You orchestrate.')

    const claude = buildAgentArgv(
      launchInput({
        kind: 'orchestrator',
        systemPrompt: 'You orchestrate.',
        initialPrompt: 'Fix the login bug'
      })
    ).argv
    expect(claude).not.toContain('Fix the login bug')
    expect(claude.at(-1)).toBe('You orchestrate.')
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
      },
      {
        provider: preset('grok'),
        orchestrator: [
          ...buildGrokOrchestratorArgs({ url, workspaceDir: cwd }),
          '--append-system-prompt',
          prompt
        ],
        subagent: [
          ...buildGrokSubagentArgs({ url, workspaceDir: cwd }),
          '--append-system-prompt',
          prompt
        ]
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
    expect(argv).toEqual(['run', '--nowordwrap', 'qwen3:32b'])
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
        provider.mcp.kind === 'kimi-project' ||
        provider.mcp.kind === 'cursor-project' ||
        provider.mcp.kind === 'grok-project'
          ? // Project-file dialects: the URL lives in the cwd, not in argv.
            readFileSync(
              join(
                cwd,
                provider.mcp.kind === 'kimi-project'
                  ? '.kimi-code'
                  : provider.mcp.kind === 'grok-project'
                    ? '.grok'
                    : '.cursor',
                provider.mcp.kind === 'grok-project' ? 'config.toml' : 'mcp.json'
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

  it('writes extra MCP servers into Claude/Codex/Kimi/Cursor launches', () => {
    const github = extraMcpServerSchema.parse({
      id: 'github',
      label: 'GitHub',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github']
    })

    const claude = buildAgentArgv(
      launchInput({ extraMcpServers: [github], kind: 'orchestrator', systemPrompt: 'Delegate.' })
    )
    const claudePath = claude.argv[claude.argv.indexOf('--mcp-config') + 1]!
    const claudeFile = JSON.parse(readFileSync(claudePath, 'utf8')) as {
      mcpServers: Record<string, unknown>
    }
    expect(claudeFile.mcpServers.github).toMatchObject({ type: 'stdio', command: 'npx' })
    expect(claude.argv[claude.argv.indexOf('--allowedTools') + 1]).toContain('mcp__github')

    const claudeSub = buildAgentArgv(launchInput({ extraMcpServers: [github] }))
    expect(claudeSub.argv).not.toContain('--allowedTools')

    const codex = buildAgentArgv(
      launchInput({ provider: preset('codex'), extraMcpServers: [github] })
    )
    expect(codex.argv).toContain('mcp_servers.github.command="npx"')

    buildAgentArgv(
      launchInput({ provider: preset('kimi'), cwd, extraMcpServers: [github] })
    )
    const kimiFile = JSON.parse(readFileSync(join(cwd, '.kimi-code', 'mcp.json'), 'utf8')) as {
      mcpServers: Record<string, unknown>
    }
    expect(kimiFile.mcpServers.github).toMatchObject({ command: 'npx' })
    expect(kimiFile.mcpServers.vertragus).toBeDefined()

    buildAgentArgv(
      launchInput({ provider: preset('cursor'), cwd, extraMcpServers: [github] })
    )
    const cursorFile = JSON.parse(readFileSync(join(cwd, '.cursor', 'mcp.json'), 'utf8')) as {
      mcpServers: Record<string, unknown>
    }
    expect(cursorFile.mcpServers.github).toMatchObject({ command: 'npx' })
    expect(cursorFile.mcpServers.vertragus).toBeDefined()
  })

  it('leaves an mcp: none launch unattached even when extras are set', () => {
    const github = extraMcpServerSchema.parse({
      id: 'github',
      label: 'GitHub',
      transport: 'stdio',
      command: 'npx'
    })
    const { argv } = buildAgentArgv(
      launchInput({ provider: preset('ollama'), model: 'qwen3:32b', extraMcpServers: [github] })
    )
    expect(argv).toEqual(['run', '--nowordwrap', 'qwen3:32b'])
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

  it('writes Grok’s project config into the worktree, never into the shared repo', () => {
    const worktree = mkdtempSync(join(tmpdir(), 'vertragus-spawn-wt-'))
    try {
      buildAgentArgv(launchInput({ provider: preset('grok'), cwd: worktree }))
      expect(existsSync(join(worktree, '.grok', 'config.toml'))).toBe(true)
      expect(existsSync(join(cwd, '.grok', 'config.toml'))).toBe(false)
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

  it('still demands faithful args when a positional goal rides a multiline system prompt', async () => {
    const resolve = vi.fn(
      async (_c: string, args: string[], _o?: ResolveLaunchOptions) => ({ file: 'grok', args })
    )
    await buildAgentLaunch(
      launchInput({
        provider: preset('grok'),
        kind: 'orchestrator',
        cwd,
        systemPrompt: 'line one\nline two',
        initialPrompt: 'Fix login'
      }),
      { resolve }
    )
    expect(resolve.mock.calls[0]![2]).toMatchObject({ requireFaithfulArgs: true })
  })

  /**
   * The long-poll lever: a Claude launch carries the raised MCP tool timeout in
   * its own environment (milliseconds), so `await_events` can block for minutes
   * instead of waking the orchestrator — and its whole context — every 50 s.
   */
  it('raises the MCP tool timeout in the environment of a Claude launch', async () => {
    const resolve = async (_c: string, args: string[]): Promise<{ file: string; args: string[] }> => ({
      file: 'claude',
      args
    })
    const launch = await buildAgentLaunch(launchInput({ kind: 'orchestrator' }), { resolve })
    expect(launch.env).toEqual({ MCP_TIMEOUT: '600000', MCP_TOOL_TIMEOUT: '600000' })
    // Nothing about the argument vector changes — the raise is env-only.
    expect(launch.argv.join(' ')).not.toContain('MCP_TIMEOUT')
  })

  it('leaves the environment alone for a provider that claims nothing', async () => {
    const resolve = async (_c: string, args: string[]): Promise<{ file: string; args: string[] }> => ({
      file: 'x',
      args
    })
    // Codex declares no timeout (unverified key on older builds) and Cursor has
    // no known mechanism at all: both spawn with a clean environment.
    for (const id of ['codex', 'cursor']) {
      const launch = await buildAgentLaunch(launchInput({ provider: preset(id), cwd }), { resolve })
      expect(launch.env).toBeUndefined()
    }
    // And a Claude-dialect provider that simply does not claim it.
    const quiet = { ...preset('claude') }
    delete quiet.mcpToolTimeoutSec
    expect((await buildAgentLaunch(launchInput({ provider: quiet }), { resolve })).env).toBeUndefined()
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

  it('hands the raised MCP timeout to the process, and nothing when unclaimed', async () => {
    const claiming = new FakePty()
    await spawnAgent(launchInput({ kind: 'orchestrator' }), {
      resolve,
      createPty: () => claiming
    })
    expect(claiming.spawnOptions?.env).toEqual({ MCP_TIMEOUT: '600000', MCP_TOOL_TIMEOUT: '600000' })

    // An unclaiming provider spawns exactly as it always did — no `env` key at
    // all, so it inherits the app environment untouched.
    const quiet = new FakePty()
    await spawnAgent(launchInput({ provider: preset('ollama'), cwd }), {
      resolve,
      createPty: () => quiet
    })
    expect(quiet.spawnOptions && 'env' in quiet.spawnOptions).toBe(false)
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

  it('pre-accepts the trust dialog for Kimi too — its dialog ate a whole assignment', async () => {
    const ensureTrust = vi.fn()
    // Kimi's modal takes the keyboard before its composer exists, so the seed's
    // keyboard gate opens on the DIALOG: the assignment is typed into a menu
    // that ignores text and the submitting Enter answers "Trust this folder".
    await spawnAgent(launchInput({ provider: preset('kimi'), cwd }), {
      resolve,
      createPty: () => new FakePty(),
      ensureTrust
    })
    expect(ensureTrust).toHaveBeenCalledExactlyOnceWith(cwd)
  })

  it('does not write Claude state for a CLI that is not the Claude preset', async () => {
    const ensureTrust = vi.fn()
    // A real cwd: Cursor's attach writes `<cwd>/.cursor/mcp.json` on the way
    // through, so the default '/repo' would leave the test writing outside tmp.
    for (const id of ['cursor', 'ollama']) {
      // `cwd` and not the fixture default: Cursor's attach writes
      // `<cwd>/.cursor/mcp.json` for real.
      await spawnAgent(launchInput({ provider: preset(id), cwd }), {
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
    await spawnAgent(launchInput({ provider: lookalike, cwd }), {
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

describe('E6 extra MCP servers', () => {
  const EXTRA = [{ name: 'browser', url: 'http://127.0.0.1:9200/mcp' }]

  it('a Claude subagent gets the extra servers in its transient config', () => {
    const { argv } = buildAgentArgv(launchInput({ extraMcp: EXTRA }))
    const configPath = argv[argv.indexOf('--mcp-config') + 1]!
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      mcpServers: Record<string, unknown>
    }
    expect(config.mcpServers.browser).toEqual({ type: 'http', url: 'http://127.0.0.1:9200/mcp' })
    expect(config.mcpServers.vertragus).toBeDefined()
  })

  it('a Codex subagent gets one -c url override per server', () => {
    const { argv } = buildAgentArgv(
      launchInput({ provider: preset('codex'), model: 'gpt-5.6', extraMcp: EXTRA })
    )
    expect(argv).toContain('mcp_servers.browser.url="http://127.0.0.1:9200/mcp"')
  })

  it('an orchestrator and a lead NEVER get extra servers, whatever the input says', () => {
    for (const kind of ['orchestrator', 'lead'] as const) {
      const { argv } = buildAgentArgv(launchInput({ kind, extraMcp: EXTRA }))
      const configPath = argv[argv.indexOf('--mcp-config') + 1]!
      const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
        mcpServers: Record<string, unknown>
      }
      expect(Object.keys(config.mcpServers)).toEqual(['vertragus'])

      const codex = buildAgentArgv(
        launchInput({ kind, provider: preset('codex'), model: 'm', extraMcp: EXTRA })
      )
      expect(codex.argv.join(' ')).not.toContain('mcp_servers.browser')
    }
  })
})
