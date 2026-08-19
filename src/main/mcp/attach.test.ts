import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  assertWrittenClaudeMcpConfig,
  assertWrittenCursorMcpConfig,
  assertWrittenKimiMcpConfig,
  bareToolName,
  buildClaudeMcpArgs,
  buildClaudeOrchestratorArgs,
  buildClaudeSubagentArgs,
  buildCodexMcpArgs,
  buildCodexOrchestratorArgs,
  buildCodexSubagentArgs,
  buildKimiMcpArgs,
  buildKimiOrchestratorArgs,
  buildKimiSubagentArgs,
  codexDeveloperInstructionsArgs,
  CURSOR_APPROVE_MCPS_FLAG,
  CURSOR_MCP_FILE,
  CURSOR_PROJECT_DIR,
  GROK_ALLOW_MCP_FLAG,
  GROK_CONFIG_FILE,
  GROK_PROJECT_DIR,
  assertWrittenGrokMcpConfig,
  buildGrokMcpArgs,
  grokAllowMcpRule,
  grokMcpServerBlock,
  mergeGrokConfigToml,
  writeGrokProjectMcpConfig,
  KIMI_AGENT_NAME,
  kimiAgentFileText,
  orchestratorAllowedTools,
  orchestratorMcpTools,
  qualifiedToolName,
  READONLY_CLAUDE_TOOLS,
  serverScopedTools,
  toClaudeMcpConfig,
  toCursorMcpConfig,
  toKimiMcpConfig,
  tomlString,
  withoutKimiAgentFileArgs,
  writeClaudeMcpConfigFile,
  writeCursorProjectMcpConfig,
  writeKimiProjectMcpConfig
} from './attach'
import { ORCHESTRATOR_TOOL_NAMES } from './toolsOrchestrator'

const URL = 'http://127.0.0.1:51234/mcp?ws=w1&token=secret'

let configDir: string
let workspaceDir: string

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'vertragus-attach-'))
  workspaceDir = mkdtempSync(join(tmpdir(), 'vertragus-attach-ws-'))
})
afterEach(() => {
  rmSync(configDir, { recursive: true, force: true })
  rmSync(workspaceDir, { recursive: true, force: true })
})

describe('claude MCP config', () => {
  it('declares one http server named vertragus', () => {
    expect(toClaudeMcpConfig(URL)).toEqual({
      mcpServers: { vertragus: { type: 'http', url: URL } }
    })
  })

  it('writes the transient file and validates it', () => {
    const path = writeClaudeMcpConfigFile(URL, configDir, 'agent-7')
    expect(path).toContain('agent-7.json')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(toClaudeMcpConfig(URL))
  })

  it('rejects a config file that lost its server entry', () => {
    const path = writeClaudeMcpConfigFile(URL, configDir, 'broken')
    writeFileSync(path, JSON.stringify({ mcpServers: {} }))
    expect(() => assertWrittenClaudeMcpConfig(path)).toThrow(/Invalid Vertragus MCP config/)
  })

  it('gives each agent its own file so parallel spawns cannot collide', () => {
    const a = writeClaudeMcpConfigFile(URL, configDir, 'a')
    const b = writeClaudeMcpConfigFile(URL, configDir, 'b')
    expect(a).not.toBe(b)
  })
})

describe('buildClaudeMcpArgs', () => {
  it('always attaches strictly — no spawn path without our server', () => {
    const args = buildClaudeMcpArgs({ url: URL, configDir, fileTag: 't' })
    expect(args[0]).toBe('--mcp-config')
    expect(args).toContain('--strict-mcp-config')
  })

  it('appends the system prompt only when there is one', () => {
    expect(buildClaudeMcpArgs({ url: URL, configDir, fileTag: 't' })).not.toContain(
      '--append-system-prompt'
    )
    const args = buildClaudeMcpArgs({
      url: URL,
      configDir,
      fileTag: 't',
      systemPrompt: 'You orchestrate.'
    })
    expect(args[args.indexOf('--append-system-prompt') + 1]).toBe('You orchestrate.')
  })
})

describe('allowlists', () => {
  it('qualifies tool names into the mcp__vertragus__ namespace', () => {
    expect(qualifiedToolName('start_agent')).toBe('mcp__vertragus__start_agent')
  })

  it('gives the orchestrator exactly its tools plus the read-only built-ins', () => {
    expect(orchestratorAllowedTools()).toEqual([
      ...ORCHESTRATOR_TOOL_NAMES.map((tool) => `mcp__vertragus__${tool}`),
      ...READONLY_CLAUDE_TOOLS
    ])
  })

  it('passes the orchestrator allowlist on the command line', () => {
    const args = buildClaudeOrchestratorArgs({ url: URL, configDir, fileTag: 'orch' })
    const list = args[args.indexOf('--allowedTools') + 1]!
    expect(list).toContain('mcp__vertragus__await_events')
    expect(list).toContain('Read')
    // The orchestrator must not be able to write code itself.
    expect(list).not.toContain('Edit')
    expect(list).not.toContain('Bash')
  })

  it('leaves subagents unrestricted but still attached', () => {
    const args = buildClaudeSubagentArgs({ url: URL, configDir, fileTag: 'sub' })
    expect(args).not.toContain('--allowedTools')
    expect(args).toContain('--strict-mcp-config')
    expect(args).toContain('--mcp-config')
  })
})

describe('server-scoped allowlists', () => {
  it('separates the process-wide list from the per-server one', () => {
    // Claude's --allowedTools is process-wide, so Read belongs in it; Codex'
    // enabled_tools and Kimi's enabledTools are per server, so it does not.
    expect(orchestratorAllowedTools()).toContain('Read')
    expect(orchestratorMcpTools()).not.toContain('Read')
    expect(orchestratorMcpTools()).toEqual(
      ORCHESTRATOR_TOOL_NAMES.map((tool) => `mcp__vertragus__${tool}`)
    )
  })

  it('strips the namespace and drops foreign tools instead of renaming them', () => {
    expect(bareToolName('mcp__vertragus__start_agent')).toBe('start_agent')
    expect(bareToolName('Read')).toBe('Read')
    expect(serverScopedTools(orchestratorAllowedTools())).toEqual([...ORCHESTRATOR_TOOL_NAMES])
    expect(serverScopedTools(undefined)).toBeUndefined()
  })
})

describe('codex attach', () => {
  it('quotes TOML scalars the way codex parses them', () => {
    expect(tomlString('plain')).toBe('"plain"')
    // A multi-line prompt has to survive as ONE TOML scalar.
    expect(tomlString('a\nb"c')).toBe('"a\\nb\\"c"')
  })

  it('attaches process-locally: url, required, pre-approved tools', () => {
    const args = buildCodexMcpArgs({ url: URL, configDir, fileTag: 'c' })
    expect(args).toEqual([
      '-c',
      `mcp_servers.vertragus.url="${URL}"`,
      '-c',
      'mcp_servers.vertragus.required=true',
      '-c',
      'mcp_servers.vertragus.default_tools_approval_mode="approve"'
    ])
    // No Anthropic flags on this path — they would kill the launch.
    expect(args).not.toContain('--mcp-config')
    expect(args).not.toContain('--append-system-prompt')
    expect(args).not.toContain('--allowedTools')
  })

  it('writes nothing to disk — a codex launch is overrides only', () => {
    buildCodexOrchestratorArgs({ url: URL, configDir, fileTag: 'c', systemPrompt: 'Delegate.' })
    expect(existsSync(join(configDir, 'vertragus-mcp'))).toBe(false)
  })

  it('gives the orchestrator enabled_tools with BARE names', () => {
    const args = buildCodexOrchestratorArgs({
      url: URL,
      configDir,
      fileTag: 'orch',
      systemPrompt: 'You orchestrate.'
    })
    expect(args).toContain(
      `mcp_servers.vertragus.enabled_tools=${JSON.stringify([...ORCHESTRATOR_TOOL_NAMES])}`
    )
    // The qualified spelling belongs to Claude's flag, not to this key.
    expect(args.join(' ')).not.toContain('mcp__vertragus__')
    expect(args).toContain('developer_instructions="You orchestrate."')
  })

  it('leaves subagents unrestricted but still attached', () => {
    const args = buildCodexSubagentArgs({ url: URL, configDir, fileTag: 'sub' })
    expect(args.some((arg) => arg.includes('enabled_tools'))).toBe(false)
    expect(args).toContain(`mcp_servers.vertragus.url="${URL}"`)
  })

  it('omits developer_instructions when there is no prompt', () => {
    expect(codexDeveloperInstructionsArgs(undefined)).toEqual([])
    expect(codexDeveloperInstructionsArgs('   ')).toEqual([])
    expect(codexDeveloperInstructionsArgs('line one\nline two')).toEqual([
      '-c',
      'developer_instructions="line one\\nline two"'
    ])
  })
})

describe('kimi attach', () => {
  it('installs .kimi-code/mcp.json in the WORKING directory, not in configDir', () => {
    const path = writeKimiProjectMcpConfig(URL, workspaceDir)
    expect(path).toBe(join(workspaceDir, '.kimi-code', 'mcp.json'))
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      mcpServers: { vertragus: { url: URL } }
    })
  })

  it('marks a bare url as HTTP and scopes the orchestrator with enabledTools', () => {
    expect(toKimiMcpConfig(URL, orchestratorAllowedTools())).toEqual({
      mcpServers: { vertragus: { url: URL, enabledTools: [...ORCHESTRATOR_TOOL_NAMES] } }
    })
  })

  it('rejects a project config that lost its server entry', () => {
    const path = writeKimiProjectMcpConfig(URL, workspaceDir)
    writeFileSync(path, JSON.stringify({ mcpServers: {} }))
    expect(() => assertWrittenKimiMcpConfig(path)).toThrow(/Invalid Vertragus Kimi MCP config/)
  })

  it('carries the system prompt as an agent file, never as a flag Kimi lacks', () => {
    const args = buildKimiOrchestratorArgs({
      url: URL,
      configDir,
      fileTag: 'orch',
      workspaceDir,
      systemPrompt: 'You orchestrate.'
    })
    expect(args[0]).toBe('--agent-file')
    // Kimi 0.34 has none of these; declaring one kills the launch.
    for (const absent of [
      '--mcp-config',
      '--mcp-config-file',
      '--strict-mcp-config',
      '--append-system-prompt',
      '--allowedTools'
    ]) {
      expect(args).not.toContain(absent)
    }
    const body = readFileSync(args[1]!, 'utf8')
    expect(body).toContain('You orchestrate.')
    expect(args[1]).toContain('orch.agent.md')
    // The project file is written even though it contributes no argument.
    expect(existsSync(join(workspaceDir, '.kimi-code', 'mcp.json'))).toBe(true)
  })

  it('writes frontmatter Kimi 0.34 actually accepts', () => {
    const text = kimiAgentFileText('Do the work.')
    // Required by kimi's parser: a kebab-case name, a non-empty description,
    // and a non-empty body. It replaces the default prompt, so no body = no
    // agent at all.
    expect(text.startsWith('---\n')).toBe(true)
    expect(text).toContain(`name: ${KIMI_AGENT_NAME}`)
    expect(KIMI_AGENT_NAME).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    expect(text).toMatch(/^description: \S.*$/m)
    expect(text.split('---')[2]!.trim()).toBe('Do the work.')
  })

  it('attaches a subagent without an allowlist and without a prompt file', () => {
    const args = buildKimiSubagentArgs({ url: URL, configDir, fileTag: 'sub', workspaceDir })
    expect(args).toEqual([])
    const written = JSON.parse(
      readFileSync(join(workspaceDir, '.kimi-code', 'mcp.json'), 'utf8')
    ) as { mcpServers: Record<string, unknown> }
    expect(written.mcpServers.vertragus).toEqual({ url: URL })
  })

  it('drops --agent-file pairs for a resumed session', () => {
    expect(
      withoutKimiAgentFileArgs(['--agent-file', '/tmp/a.md', '--yolo', '--agent-file', '/tmp/b.md'])
    ).toEqual(['--yolo'])
    expect(withoutKimiAgentFileArgs([])).toEqual([])
  })

  it('never attaches without a config file — the one thing Kimi cannot be told', () => {
    buildKimiMcpArgs({ url: URL, configDir, fileTag: 'k', workspaceDir })
    expect(existsSync(join(workspaceDir, '.kimi-code', 'mcp.json'))).toBe(true)
  })
})

describe('cursor attach', () => {
  it('installs .cursor/mcp.json in the WORKING directory with a bare url', () => {
    const path = writeCursorProjectMcpConfig(URL, workspaceDir)
    expect(path).toBe(join(workspaceDir, CURSOR_PROJECT_DIR, CURSOR_MCP_FILE))
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      mcpServers: { vertragus: { url: URL } }
    })
  })

  it('merges vertragus into an existing file and preserves foreign servers', () => {
    const dir = join(workspaceDir, CURSOR_PROJECT_DIR)
    // mkdir happens inside the writer; seed the file first so the merge path runs.
    writeCursorProjectMcpConfig('http://127.0.0.1:1/old', workspaceDir)
    writeFileSync(
      join(dir, CURSOR_MCP_FILE),
      JSON.stringify({
        mcpServers: {
          'user-server': { url: 'http://127.0.0.1:9/user' },
          vertragus: { url: 'http://127.0.0.1:1/stale' }
        },
        extraTopLevel: true
      })
    )

    const path = writeCursorProjectMcpConfig(URL, workspaceDir)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      mcpServers: {
        'user-server': { url: 'http://127.0.0.1:9/user' },
        vertragus: { url: URL }
      },
      extraTopLevel: true
    })
  })

  it('replaces a corrupt existing file instead of guessing', () => {
    const dir = join(workspaceDir, CURSOR_PROJECT_DIR)
    writeCursorProjectMcpConfig(URL, workspaceDir)
    writeFileSync(join(dir, CURSOR_MCP_FILE), '{not-json')

    const path = writeCursorProjectMcpConfig(URL, workspaceDir)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      mcpServers: { vertragus: { url: URL } }
    })
  })

  it('replaces a non-object JSON file the same way (fail-closed)', () => {
    const dir = join(workspaceDir, CURSOR_PROJECT_DIR)
    writeCursorProjectMcpConfig(URL, workspaceDir)
    writeFileSync(join(dir, CURSOR_MCP_FILE), JSON.stringify(['garbage']))

    expect(JSON.parse(readFileSync(writeCursorProjectMcpConfig(URL, workspaceDir), 'utf8'))).toEqual(
      {
        mcpServers: { vertragus: { url: URL } }
      }
    )
  })

  it('builds the merge from an absent existing object', () => {
    expect(toCursorMcpConfig(null, URL)).toEqual({
      mcpServers: { vertragus: { url: URL } }
    })
    expect(toCursorMcpConfig({ mcpServers: { other: { url: 'x' } } }, URL)).toEqual({
      mcpServers: { other: { url: 'x' }, vertragus: { url: URL } }
    })
  })

  it('rejects a project config that lost its server entry', () => {
    const path = writeCursorProjectMcpConfig(URL, workspaceDir)
    writeFileSync(path, JSON.stringify({ mcpServers: {} }))
    expect(() => assertWrittenCursorMcpConfig(path)).toThrow(/Invalid Vertragus Cursor MCP config/)
  })

  it('exports the launch flag that pre-approves project MCP servers', () => {
    // Cursor has no verified per-server tool filter; approval is this flag alone.
    expect(CURSOR_APPROVE_MCPS_FLAG).toBe('--approve-mcps')
  })
})

describe('grok attach', () => {
  it('installs .grok/config.toml in the WORKING directory with a TOML url', () => {
    const path = writeGrokProjectMcpConfig(URL, workspaceDir)
    expect(path).toBe(join(workspaceDir, GROK_PROJECT_DIR, GROK_CONFIG_FILE))
    expect(readFileSync(path, 'utf8')).toBe(grokMcpServerBlock(URL))
  })

  it('merges vertragus into an existing file and preserves foreign tables', () => {
    const dir = join(workspaceDir, GROK_PROJECT_DIR)
    writeGrokProjectMcpConfig('http://127.0.0.1:1/old', workspaceDir)
    writeFileSync(
      join(dir, GROK_CONFIG_FILE),
      [
        '[plugins]',
        'enabled = ["mine"]',
        '',
        '[mcp_servers.user-server]',
        'url = "http://127.0.0.1:9/user"',
        '',
        '[mcp_servers.vertragus]',
        'url = "http://127.0.0.1:1/stale"',
        '',
        '[permission]',
        'allow = ["Read"]',
        ''
      ].join('\n')
    )

    const path = writeGrokProjectMcpConfig(URL, workspaceDir)
    const written = readFileSync(path, 'utf8')
    expect(written).toContain('[plugins]')
    expect(written).toContain('enabled = ["mine"]')
    expect(written).toContain('[mcp_servers.user-server]')
    expect(written).toContain('url = "http://127.0.0.1:9/user"')
    expect(written).toContain('[permission]')
    expect(written).toContain('allow = ["Read"]')
    expect(written).toContain(grokMcpServerBlock(URL).trim())
    expect(written).not.toContain('stale')
  })

  it('replaces a quoted [mcp_servers."vertragus"] header too', () => {
    expect(
      mergeGrokConfigToml('[mcp_servers."vertragus"]\nurl = "old"\n', URL)
    ).toBe(grokMcpServerBlock(URL))
  })

  it('appends when the file has no vertragus table yet', () => {
    const existing = '[mcp_servers.other]\ncommand = "npx"\n'
    expect(mergeGrokConfigToml(existing, URL)).toBe(
      `${existing.trimEnd()}\n\n${grokMcpServerBlock(URL)}`
    )
  })

  it('rejects a project config that lost its server entry', () => {
    const path = writeGrokProjectMcpConfig(URL, workspaceDir)
    writeFileSync(path, '[mcp_servers.other]\nurl = "http://127.0.0.1:9/x"\n')
    expect(() => assertWrittenGrokMcpConfig(path, URL)).toThrow(/Invalid Vertragus Grok MCP config/)
  })

  it('pre-allows the Vertragus MCP tools on the command line', () => {
    const args = buildGrokMcpArgs({ url: URL, workspaceDir })
    expect(args).toEqual([GROK_ALLOW_MCP_FLAG, grokAllowMcpRule()])
    expect(args).toEqual(['--allow', 'MCPTool(vertragus__*)'])
    expect(existsSync(join(workspaceDir, GROK_PROJECT_DIR, GROK_CONFIG_FILE))).toBe(true)
  })
})
