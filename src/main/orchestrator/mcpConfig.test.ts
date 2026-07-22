import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildClaudeMcpArgs,
  buildCodexMcpArgs,
  buildCopilotMcpArgs,
  buildKimiMcpArgs,
  claudeAllowedTools,
  codexServerArgs,
  toClaudeMcpConfig,
  toCopilotMcpConfig,
  type McpServerSpec
} from './mcpConfig'

const vertragus: McpServerSpec = {
  name: 'vertragus',
  transport: 'http',
  url: 'http://127.0.0.1:1234/mcp',
  allowedTools: ['mcp__vertragus__execute_plan', 'mcp__vertragus__set_goal'],
  required: true,
  approvalMode: 'approve'
}

const filesystem: McpServerSpec = {
  name: 'filesystem',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
  env: { ROOT: '/tmp' }
}

const remote: McpServerSpec = {
  name: 'websearch',
  transport: 'sse',
  url: 'https://example.com/mcp',
  headers: { Authorization: 'Bearer abc' }
}

describe('toClaudeMcpConfig', () => {
  it('maps http and stdio servers into Claude config entries', () => {
    const config = toClaudeMcpConfig([vertragus, filesystem, remote])
    expect(config.mcpServers.vertragus).toEqual({ type: 'http', url: 'http://127.0.0.1:1234/mcp' })
    expect(config.mcpServers.filesystem).toEqual({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
      env: { ROOT: '/tmp' }
    })
    expect(config.mcpServers.websearch).toEqual({
      type: 'sse',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer abc' }
    })
  })
})

describe('claudeAllowedTools', () => {
  it('uses explicit allowlists and server-wide wildcards', () => {
    const tools = claudeAllowedTools([vertragus, filesystem], false)
    expect(tools).toContain('mcp__vertragus__execute_plan')
    expect(tools).toContain('mcp__vertragus__set_goal')
    // external server with no explicit allowlist -> wildcard
    expect(tools).toContain('mcp__filesystem')
  })

  it('adds read-only built-ins only when requested', () => {
    expect(claudeAllowedTools([filesystem], true)).toContain('Read')
    expect(claudeAllowedTools([filesystem], false)).not.toContain('Read')
  })
})

describe('buildClaudeMcpArgs', () => {
  it('writes a unique config file and returns strict orchestrator args', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vertragus-mcp-test-'))
    try {
      const args = buildClaudeMcpArgs([vertragus, filesystem], {
        configDir: dir,
        fileTag: 'orch-01',
        strict: true,
        systemPrompt: 'Delegate.',
        includeReadonlyTools: true
      })
      expect(args).toContain('--strict-mcp-config')
      expect(args).toContain('--append-system-prompt')
      expect(args).toContain('Delegate.')
      const configIdx = args.indexOf('--mcp-config')
      const path = args[configIdx + 1]
      expect(path.endsWith(join('vertragus-mcp', 'orch-01.json'))).toBe(true)
      const written = JSON.parse(readFileSync(path, 'utf8'))
      expect(written.mcpServers.filesystem.command).toBe('npx')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('omits strict and system prompt for subagents', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vertragus-mcp-test-'))
    try {
      const args = buildClaudeMcpArgs([filesystem], {
        configDir: dir,
        fileTag: 'sub-02',
        strict: false
      })
      expect(args).not.toContain('--strict-mcp-config')
      expect(args).not.toContain('--append-system-prompt')
      expect(args).toContain('--allowedTools')
      expect(args).toContain('mcp__filesystem')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns no args when there are no servers', () => {
    expect(buildClaudeMcpArgs([], { configDir: '.', fileTag: 'x', strict: false })).toEqual([])
  })
})

describe('buildKimiMcpArgs', () => {
  it('mirrors Claude args but points Kimi at --mcp-config-file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vertragus-mcp-test-'))
    try {
      const args = buildKimiMcpArgs([vertragus, filesystem], {
        configDir: dir,
        fileTag: 'orch-kimi',
        strict: true,
        systemPrompt: 'Delegate.',
        includeReadonlyTools: true
      })
      // Kimi Code CLI uses --mcp-config-file, never Claude's --mcp-config.
      expect(args).toContain('--mcp-config-file')
      expect(args).not.toContain('--mcp-config')
      expect(args).toContain('--strict-mcp-config')
      expect(args).toContain('--append-system-prompt')
      const configIdx = args.indexOf('--mcp-config-file')
      const path = args[configIdx + 1]
      expect(path.endsWith(join('vertragus-mcp', 'orch-kimi.json'))).toBe(true)
      // The written config shape is shared with Claude.
      const written = JSON.parse(readFileSync(path, 'utf8'))
      expect(written.mcpServers.vertragus).toEqual({ type: 'http', url: 'http://127.0.0.1:1234/mcp' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns no args when there are no servers', () => {
    expect(buildKimiMcpArgs([], { configDir: '.', fileTag: 'x', strict: false })).toEqual([])
  })
})

describe('codexServerArgs', () => {
  it('builds process-local overrides for an http server with an allowlist', () => {
    const args = codexServerArgs(vertragus)
    expect(args).toContain('mcp_servers.vertragus.url="http://127.0.0.1:1234/mcp"')
    expect(args).toContain('mcp_servers.vertragus.required=true')
    expect(args).toContain(
      'mcp_servers.vertragus.default_tools_approval_mode=' + JSON.stringify('approve')
    )
    // enabled_tools are the bare names (mcp__vertragus__ prefix stripped)
    expect(args).toContain('mcp_servers.vertragus.enabled_tools=["execute_plan","set_goal"]')
  })

  it('builds command, args and env overrides for a stdio server', () => {
    const args = codexServerArgs(filesystem)
    expect(args).toContain('mcp_servers.filesystem.command="npx"')
    expect(args).toContain(
      'mcp_servers.filesystem.args=["-y","@modelcontextprotocol/server-filesystem","/tmp"]'
    )
    expect(args).toContain('mcp_servers.filesystem.env.ROOT="/tmp"')
    // external servers get all tools -> no enabled_tools restriction
    expect(args.some((arg) => arg.includes('enabled_tools'))).toBe(false)
  })
})

describe('buildCodexMcpArgs', () => {
  it('prepends developer_instructions and covers every server', () => {
    const args = buildCodexMcpArgs([vertragus, filesystem], { systemPrompt: 'Delegate.' })
    expect(args).toContain('developer_instructions="Delegate."')
    expect(args).toContain('mcp_servers.vertragus.url="http://127.0.0.1:1234/mcp"')
    expect(args).toContain('mcp_servers.filesystem.command="npx"')
  })
})

describe('buildCopilotMcpArgs', () => {
  it('creates transient config and narrow tool approvals', () => {
    const args = buildCopilotMcpArgs([vertragus, filesystem])
    const configIndex = args.indexOf('--additional-mcp-config')
    const config = JSON.parse(args[configIndex + 1])
    expect(config).toEqual(toCopilotMcpConfig([vertragus, filesystem]))
    expect(config.mcpServers.vertragus.tools).toEqual(['execute_plan', 'set_goal'])
    expect(config.mcpServers.filesystem).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
      env: { ROOT: '/tmp' },
      tools: ['*']
    })
    expect(args).toContain('--allow-all-mcp-server-instructions')
    expect(args).toContain('vertragus(execute_plan),vertragus(set_goal)')
  })

  it('does nothing without servers', () => {
    expect(buildCopilotMcpArgs([])).toEqual([])
  })
})
