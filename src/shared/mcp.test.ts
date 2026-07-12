import { describe, expect, it } from 'vitest'
import {
  emptyMcpServer,
  isMcpServerComplete,
  mcpScopeMatches,
  mcpServerSchema,
  providerSupportsExternalMcp
} from './mcp'

describe('mcpScopeMatches', () => {
  it('honours all / orchestrator / subagents scopes', () => {
    expect(mcpScopeMatches('all', 'orchestrator')).toBe(true)
    expect(mcpScopeMatches('all', 'subagent')).toBe(true)
    expect(mcpScopeMatches('orchestrator', 'orchestrator')).toBe(true)
    expect(mcpScopeMatches('orchestrator', 'subagent')).toBe(false)
    expect(mcpScopeMatches('subagents', 'subagent')).toBe(true)
    expect(mcpScopeMatches('subagents', 'orchestrator')).toBe(false)
  })
})

describe('providerSupportsExternalMcp', () => {
  it('is true only for claude and codex', () => {
    expect(providerSupportsExternalMcp('claude')).toBe(true)
    expect(providerSupportsExternalMcp('codex')).toBe(true)
    expect(providerSupportsExternalMcp('cursor')).toBe(false)
    expect(providerSupportsExternalMcp('copilot')).toBe(false)
    expect(providerSupportsExternalMcp('ollama')).toBe(false)
  })
})

describe('isMcpServerComplete', () => {
  it('requires a command for stdio and a url for http/sse', () => {
    const stdio = { ...emptyMcpServer('a'), name: 'fs', transport: 'stdio' as const }
    expect(isMcpServerComplete(stdio)).toBe(false)
    expect(isMcpServerComplete({ ...stdio, command: 'npx' })).toBe(true)

    const http = { ...emptyMcpServer('b'), name: 'web', transport: 'http' as const }
    expect(isMcpServerComplete(http)).toBe(false)
    expect(isMcpServerComplete({ ...http, url: 'https://x/mcp' })).toBe(true)
  })

  it('rejects invalid names', () => {
    const bad = { ...emptyMcpServer('c'), name: 'has space', transport: 'stdio' as const, command: 'x' }
    expect(isMcpServerComplete(bad)).toBe(false)
  })
})

describe('mcpServerSchema', () => {
  it('applies defaults for a minimal entry', () => {
    const parsed = mcpServerSchema.parse({ id: 'x', name: 'fs' })
    expect(parsed.enabled).toBe(true)
    expect(parsed.transport).toBe('stdio')
    expect(parsed.scope).toBe('all')
    expect(parsed.args).toEqual([])
    expect(parsed.env).toEqual({})
  })

  it('rejects invalid names', () => {
    expect(() => mcpServerSchema.parse({ id: 'x', name: 'bad name' })).toThrow()
  })
})
