import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  extraMcpServerSchema,
  type ExtraMcpServer
} from '@shared/schema/mcpServer'
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
  claudeMcpTimeoutEnv,
  CLAUDE_MCP_TIMEOUT_ENV,
  CLAUDE_MCP_TOOL_TIMEOUT_ENV,
  codexDeveloperInstructionsArgs,
  codexExtraServerOverrides,
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
  usableExtraMcp,
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

/**
 * The long-poll budget. `await_events` can only block for minutes if the CLI
 * stops killing the tool call at 60 s — Claude reads that limit from its
 * environment, in milliseconds, and a provider that makes no claim must keep
 * spawning with a clean environment.
 */
describe('claude MCP tool timeout', () => {
  it('translates declared seconds into the millisecond env pair', () => {
    expect(claudeMcpTimeoutEnv(600)).toEqual({
      [CLAUDE_MCP_TIMEOUT_ENV]: '600000',
      [CLAUDE_MCP_TOOL_TIMEOUT_ENV]: '600000'
    })
    // Startup AND tool call: raising one of the two is a 60 s failure that
    // nobody can place.
    expect(Object.keys(claudeMcpTimeoutEnv(600) ?? {})).toEqual(['MCP_TIMEOUT', 'MCP_TOOL_TIMEOUT'])
  })

  it('stays silent for a provider that makes no claim', () => {
    expect(claudeMcpTimeoutEnv(undefined)).toBeUndefined()
    expect(claudeMcpTimeoutEnv(0)).toBeUndefined()
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

  /**
   * Codex spells the raised timeout as one more process-local override. It is
   * emitted ONLY on demand: no shipped preset claims it, because an older codex
   * meeting an unknown `mcp_servers.*` key could refuse to start — and a launch
   * that never starts is worse than a 50 s poll.
   */
  it('adds tool_timeout_sec only when the provider declares one', () => {
    const plain = buildCodexMcpArgs({ url: URL, configDir, fileTag: 'c' })
    expect(plain.some((arg) => arg.includes('tool_timeout_sec'))).toBe(false)

    const raised = buildCodexMcpArgs({ url: URL, configDir, fileTag: 'c', toolTimeoutSec: 600 })
    expect(raised).toContain('mcp_servers.vertragus.tool_timeout_sec=600')
    // Seconds here, unlike Claude's millisecond env pair.
    expect(raised).not.toContain('mcp_servers.vertragus.tool_timeout_sec=600000')
    // Everything else about the attachment is untouched.
    expect(raised.slice(0, plain.length)).toEqual(plain)
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

describe('E6 extra MCP servers', () => {
  const EXTRA = [{ name: 'browser', url: 'http://127.0.0.1:9200/mcp' }]

  it('claude: extra servers land in the same strict transient file', () => {
    expect(toClaudeMcpConfig(URL, EXTRA)).toEqual({
      mcpServers: {
        vertragus: { type: 'http', url: URL },
        browser: { type: 'http', url: 'http://127.0.0.1:9200/mcp' }
      }
    })
    const path = writeClaudeMcpConfigFile(URL, configDir, 'extra', EXTRA)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(toClaudeMcpConfig(URL, EXTRA))
  })

  it('codex: one url override per server, nothing else', () => {
    expect(codexExtraServerOverrides(EXTRA)).toEqual([
      '-c',
      `mcp_servers.browser.url=${tomlString('http://127.0.0.1:9200/mcp')}`
    ])
    expect(codexExtraServerOverrides(undefined)).toEqual([])
  })

  it('kimi: extra servers join the project file next to vertragus', () => {
    expect(toKimiMcpConfig(URL, undefined, EXTRA)).toEqual({
      mcpServers: {
        vertragus: { url: URL },
        browser: { url: 'http://127.0.0.1:9200/mcp' }
      }
    })
  })

  it('cursor: extra servers merge without touching foreign entries', () => {
    const existing = { mcpServers: { theirs: { url: 'http://example.test/mcp' } } }
    expect(toCursorMcpConfig(existing, URL, EXTRA).mcpServers).toEqual({
      theirs: { url: 'http://example.test/mcp' },
      vertragus: { url: URL },
      browser: { url: 'http://127.0.0.1:9200/mcp' }
    })
  })

  it('grok: one table per extra server, replaced on re-run, foreign tables intact', () => {
    const existing = '[permission]\nmode = "ask"\n\n[mcp_servers.browser]\nurl = "http://old"\n'
    const merged = mergeGrokConfigToml(existing, URL, EXTRA)
    expect(merged).toContain('[permission]')
    expect(merged).toContain(grokMcpServerBlock(URL).trim())
    expect(merged).toContain('url = "http://127.0.0.1:9200/mcp"')
    expect(merged).not.toContain('http://old')
    // Idempotent: a second merge changes nothing.
    expect(mergeGrokConfigToml(merged, URL, EXTRA)).toBe(merged)
  })

  it('defence-in-depth: a server named vertragus is dropped by every writer', () => {
    const shadow = [{ name: 'Vertragus', url: 'http://evil.test/mcp' }]
    expect(usableExtraMcp(shadow)).toEqual([])
    expect(toClaudeMcpConfig(URL, shadow).mcpServers).toEqual({
      vertragus: { type: 'http', url: URL }
    })
    expect(codexExtraServerOverrides(shadow)).toEqual([])
  })
})

const GITHUB = extraMcpServerSchema.parse({
  id: 'github',
  label: 'GitHub',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-github'],
  env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'secret' }
})

const LINEAR = extraMcpServerSchema.parse({
  id: 'linear',
  label: 'Linear',
  transport: 'http',
  url: 'https://mcp.linear.app/mcp',
  headers: { Authorization: 'Bearer x' }
})

const DISABLED: ExtraMcpServer = extraMcpServerSchema.parse({
  ...GITHUB,
  id: 'off',
  enabled: false
})

const RESERVED: ExtraMcpServer = { ...GITHUB, id: 'vertragus' }

describe('extra MCP servers', () => {
  it('puts extras next to vertragus in the Claude config', () => {
    expect(toClaudeMcpConfig(URL, [GITHUB, LINEAR])).toEqual({
      mcpServers: {
        vertragus: { type: 'http', url: URL },
        github: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'secret' }
        },
        linear: {
          type: 'http',
          url: 'https://mcp.linear.app/mcp',
          headers: { Authorization: 'Bearer x' }
        }
      }
    })
  })

  it('skips disabled and reserved extras and never replaces vertragus', () => {
    const claude = toClaudeMcpConfig(URL, [DISABLED, RESERVED, GITHUB])
    expect(claude.mcpServers.vertragus).toEqual({ type: 'http', url: URL })
    expect(claude.mcpServers).not.toHaveProperty('off')
    expect(Object.keys(claude.mcpServers)).toEqual(['vertragus', 'github'])

    const kimi = toKimiMcpConfig(URL, undefined, [RESERVED, GITHUB])
    expect(kimi.mcpServers.vertragus).toEqual({ url: URL })
    expect(kimi.mcpServers.github).toEqual({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'secret' }
    })
  })

  it('writes extras into Claude’s transient file under strict mode', () => {
    const path = writeClaudeMcpConfigFile(URL, configDir, 'extra', [GITHUB])
    const written = JSON.parse(readFileSync(path, 'utf8')) as {
      mcpServers: Record<string, unknown>
    }
    expect(written.mcpServers.vertragus).toEqual({ type: 'http', url: URL })
    expect(written.mcpServers.github).toMatchObject({ type: 'stdio', command: 'npx' })
  })

  it('appends mcp__github to Claude orchestrator --allowedTools, not to subagents', () => {
    const orch = buildClaudeOrchestratorArgs({
      url: URL,
      configDir,
      fileTag: 'orch',
      extraMcpServers: [GITHUB]
    })
    const list = orch[orch.indexOf('--allowedTools') + 1]!
    expect(list).toContain('mcp__github')
    expect(list).toContain('mcp__vertragus__await_events')

    const sub = buildClaudeSubagentArgs({
      url: URL,
      configDir,
      fileTag: 'sub',
      extraMcpServers: [GITHUB]
    })
    expect(sub).not.toContain('--allowedTools')
  })

  it('adds Codex extra overrides without required=true or enabled_tools', () => {
    const extras = codexExtraServerOverrides([GITHUB, LINEAR])
    expect(extras).toContain('mcp_servers.github.command="npx"')
    expect(extras).toContain(
      `mcp_servers.github.args=${JSON.stringify(['-y', '@modelcontextprotocol/server-github'])}`
    )
    expect(extras).toContain('mcp_servers.github.env.GITHUB_PERSONAL_ACCESS_TOKEN="secret"')
    expect(extras).toContain('mcp_servers.linear.url="https://mcp.linear.app/mcp"')
    expect(extras.join(' ')).not.toMatch(/mcp_servers\.(github|linear)\.required/)
    expect(extras.join(' ')).not.toContain('enabled_tools')

    const args = buildCodexMcpArgs({
      url: URL,
      configDir,
      fileTag: 'c',
      extraMcpServers: [GITHUB]
    })
    expect(args).toContain('mcp_servers.vertragus.required=true')
    expect(args).toContain('mcp_servers.github.command="npx"')
  })

  it('merges extras into Kimi next to vertragus without enabledTools on extras', () => {
    expect(toKimiMcpConfig(URL, orchestratorAllowedTools(), [GITHUB, LINEAR])).toEqual({
      mcpServers: {
        vertragus: { url: URL, enabledTools: [...ORCHESTRATOR_TOOL_NAMES] },
        github: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'secret' }
        },
        linear: { url: 'https://mcp.linear.app/mcp' }
      }
    })
  })

  it('preserves a foreign Cursor server, lets extras win collisions, keeps vertragus last', () => {
    const existing = {
      mcpServers: {
        'user-server': { url: 'http://127.0.0.1:9/user' },
        github: { url: 'http://127.0.0.1:9/old-github' },
        vertragus: { url: 'http://127.0.0.1:1/stale' }
      }
    }
    const merged = toCursorMcpConfig(existing, URL, [GITHUB, RESERVED])
    expect(merged.mcpServers['user-server']).toEqual({ url: 'http://127.0.0.1:9/user' })
    expect(merged.mcpServers.github).toEqual({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'secret' }
    })
    expect(merged.mcpServers.vertragus).toEqual({ url: URL })
    expect(Object.keys(merged.mcpServers).at(-1)).toBe('vertragus')
  })
})
