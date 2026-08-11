import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  assertWrittenClaudeMcpConfig,
  buildClaudeMcpArgs,
  buildClaudeOrchestratorArgs,
  buildClaudeSubagentArgs,
  buildCodexMcpArgs,
  buildKimiMcpArgs,
  orchestratorAllowedTools,
  qualifiedToolName,
  READONLY_CLAUDE_TOOLS,
  toClaudeMcpConfig,
  writeClaudeMcpConfigFile
} from './attach'
import { ORCHESTRATOR_TOOL_NAMES } from './toolsOrchestrator'

const URL = 'http://127.0.0.1:51234/mcp?ws=w1&token=secret'

let configDir: string

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'vertragus-attach-'))
})
afterEach(() => {
  rmSync(configDir, { recursive: true, force: true })
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

  it('gives the orchestrator exactly its six tools plus the read-only built-ins', () => {
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

describe('other providers', () => {
  it('fail loudly instead of silently spawning an unattached agent', () => {
    expect(() => buildCodexMcpArgs({ url: URL, configDir, fileTag: 'c' })).toThrow(/M5/)
    expect(() =>
      buildKimiMcpArgs({ url: URL, configDir, fileTag: 'k', workspaceDir: configDir })
    ).toThrow(/M5/)
  })
})
