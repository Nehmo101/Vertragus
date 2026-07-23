import { describe, expect, it, vi } from 'vitest'

const mcp = vi.hoisted(() => ({
  handle: {
    url: 'http://127.0.0.1:4321/mcp?token=secret',
    allowedTools: ['mcp__vertragus__set_goal'],
    close: async () => undefined
  } as { url: string; allowedTools: string[]; close(): Promise<void> } | null,
  overlay: undefined as string | undefined
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/vertragus-solo-test', getName: () => 'test', isPackaged: false },
  BrowserWindow: class {},
  shell: { openExternal: vi.fn() }
}))
vi.mock('@main/windows', () => ({ createPaneWindow: vi.fn(), broadcast: vi.fn() }))
vi.mock('@main/config/store', () => ({
  getProfile: () => undefined,
  getActiveProfileId: () => 'default',
  getSetting: () => undefined,
  setSetting: vi.fn()
}))
vi.mock('@main/agents/AgentManager', () => ({
  agentManager: { runTask: vi.fn(), kill: vi.fn(), list: () => [] }
}))
vi.mock('@main/orchestrator/mcpHandle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./mcpHandle')>()
  return { ...actual, getMcpHandle: () => mcp.handle }
})
vi.mock('@main/orchestrator/externalMcp', () => ({ externalMcpSpecsFor: () => [] }))
vi.mock('@main/orchestrator/promptOverlay', () => ({ getPromptOverlay: () => mcp.overlay }))
vi.mock('@main/orchestrator/mcpConfig', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./mcpConfig')>()
  return {
    ...actual,
    // Avoid writing config files to disk; capture the server specs instead.
    buildClaudeMcpArgs: vi.fn((servers: unknown[], opts: Record<string, unknown>) => [
      JSON.stringify({ servers, opts })
    ])
  }
})

import { buildSoloSetup, soloSystemPrompt } from './soloLaunch'
import { SOLO_ALLOWED_TOOLS } from './mcpHandle'

describe('Efficiency-Solo launch setup', () => {
  it('attaches the minimal solo MCP session with the solo allowlist and prompt', () => {
    mcp.overlay = 'Regel 1: Keine Blind-Retries.'
    const setup = buildSoloSetup('claude', 'Caronte', 'sub-01', 'session-1', { engineId: 'engine-1' })
    expect(setup.capability.supported).toBe(true)

    const { servers, opts } = JSON.parse(setup.extraArgs[0]) as {
      servers: Array<{ name: string; url: string; allowedTools: string[] }>
      opts: { systemPrompt: string; strict: boolean }
    }
    expect(servers).toHaveLength(1)
    expect(servers[0].name).toBe('vertragus')
    expect(servers[0].allowedTools).toEqual(SOLO_ALLOWED_TOOLS)
    const url = new URL(servers[0].url)
    expect(url.searchParams.get('solo')).toBe('sub-01')
    expect(url.searchParams.get('workspaceSession')).toBe('session-1')
    expect(url.searchParams.get('engineId')).toBe('engine-1')
    // Compact solo contract + reviewed overlay, no orchestrator plan contract.
    expect(opts.systemPrompt).toContain('SOLO-Agent')
    expect(opts.systemPrompt).toContain('Regel 1: Keine Blind-Retries.')
    expect(opts.systemPrompt).not.toContain('execute_plan')
  })

  it('degrades gracefully without a running MCP server', () => {
    const previous = mcp.handle
    mcp.handle = null
    try {
      const setup = buildSoloSetup('claude', 'Caronte', 'sub-01')
      expect(setup.extraArgs).toEqual([])
    } finally {
      mcp.handle = previous
    }
  })

  it('reports unsupported providers via capability', () => {
    const setup = buildSoloSetup('cursor', 'Caronte', 'sub-01')
    expect(setup.capability.supported).toBe(false)
    expect(setup.extraArgs).toEqual([])
  })

  it('keeps the solo prompt an order of magnitude smaller than the orchestrator contract', () => {
    const prompt = soloSystemPrompt('Caronte')
    expect(prompt.split('\n').length).toBeLessThan(15)
  })
})
