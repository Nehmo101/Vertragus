import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildClaudeMcpArgs,
  buildCodexMcpArgs,
  buildCopilotMcpArgs,
  claudeAllowedTools,
  codexServerArgs,
  toClaudeMcpConfig,
  toCopilotMcpConfig,
  type McpServerSpec
} from './mcpConfig'

const orca: McpServerSpec = {
  name: 'orca',
  transport: 'http',
  url: 'http://127.0.0.1:1234/mcp',
  allowedTools: ['mcp__orca__execute_plan', 'mcp__orca__set_goal'],
  required: true
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
    const config = toClaudeMcpConfig([orca, filesystem, remote])
    expect(config.mcpServers.orca).toEqual({ type: 'http', url: 'http://127.0.0.1:1234/mcp' })
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
    const tools = claudeAllowedTools([orca, filesystem], false)
    expect(tools).toContain('mcp__orca__execute_plan')
    expect(tools).toContain('mcp__orca__set_goal')
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
    const dir = mkdtempSync(join(tmpdir(), 'orca-mcp-test-'))
    try {
      const args = buildClaudeMcpArgs([orca, filesystem], {
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
      expect(path.endsWith(join('orca-mcp', 'orch-01.json'))).toBe(true)
      const written = JSON.parse(readFileSync(path, 'utf8'))
      expect(written.mcpServers.filesystem.command).toBe('npx')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('omits strict and system prompt for subagents', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-mcp-test-'))
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

describe('codexServerArgs', () => {
  it('builds process-local overrides for an http server with an allowlist', () => {
    const args = codexServerArgs(orca)
    expect(args).toContain('mcp_servers.orca.url="http://127.0.0.1:1234/mcp"')
    expect(args).toContain('mcp_servers.orca.required=true')
    // enabled_tools are the bare names (mcp__orca__ prefix stripped)
    expect(args).toContain('mcp_servers.orca.enabled_tools=["execute_plan","set_goal"]')
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
    const args = buildCodexMcpArgs([orca, filesystem], { systemPrompt: 'Delegate.' })
    expect(args).toContain('developer_instructions="Delegate."')
    expect(args).toContain('mcp_servers.orca.url="http://127.0.0.1:1234/mcp"')
    expect(args).toContain('mcp_servers.filesystem.command="npx"')
  })
})

describe('buildCopilotMcpArgs', () => {
  it('creates transient config and narrow tool approvals', () => {
    const args = buildCopilotMcpArgs([orca, filesystem])
    const configIndex = args.indexOf('--additional-mcp-config')
    const config = JSON.parse(args[configIndex + 1])
    expect(config).toEqual(toCopilotMcpConfig([orca, filesystem]))
    expect(config.mcpServers.orca.tools).toEqual(['execute_plan', 'set_goal'])
    expect(config.mcpServers.filesystem).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
      env: { ROOT: '/tmp' },
      tools: ['*']
    })
    expect(args).toContain('--allow-all-mcp-server-instructions')
    expect(args).toContain('orca(execute_plan),orca(set_goal)')
  })

  it('does nothing without servers', () => {
    expect(buildCopilotMcpArgs([])).toEqual([])
  })
})
