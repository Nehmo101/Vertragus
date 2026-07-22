import { describe, expect, it } from 'vitest'
import { getOrchestratorAdapter, listOrchestratorCapabilities } from './providerAdapters'

const context = {
  name: 'Virgilio',
  handle: {
    url: 'http://127.0.0.1:39123/mcp?token=test',
    allowedTools: ['mcp__vertragus__set_goal', 'mcp__vertragus__execute_plan'],
    close: async () => undefined,
  },
  configDir: '.',
  systemPrompt: 'Delegate work.',
  externalServers: []
}

describe('orchestrator provider adapters', () => {
  it('exposes exactly the providers with verified transient MCP adapters', () => {
    const supported = listOrchestratorCapabilities()
      .filter((capability) => capability.supported)
      .map((capability) => capability.provider)
    expect(supported).toEqual(['claude', 'kimi', 'codex', 'copilot'])
  })

  it('builds a process-local Copilot MCP configuration and tool allowlist', () => {
    const adapter = getOrchestratorAdapter('copilot')
    const args = adapter.buildArgs(context)
    expect(adapter.capability).toMatchObject({
      supported: true,
      transport: 'mcp-http',
      transientConfig: true
    })
    const configIndex = args.indexOf('--additional-mcp-config')
    const config = JSON.parse(args[configIndex + 1])
    expect(config.mcpServers.vertragus).toEqual({
      type: 'http',
      url: context.handle.url,
      tools: ['set_goal', 'execute_plan']
    })
    expect(args).toContain('--allow-all-mcp-server-instructions')
    expect(args).toContain('vertragus(set_goal),vertragus(execute_plan)')
  })

  it('pre-approves only Vertragus-owned orchestration tools for Codex', () => {
    const args = getOrchestratorAdapter('codex').buildArgs(context)
    expect(args).toContain(
      'mcp_servers.vertragus.default_tools_approval_mode=' + JSON.stringify('approve')
    )
    expect(args).toContain(
      'mcp_servers.vertragus.enabled_tools=' + JSON.stringify(['set_goal', 'execute_plan'])
    )
  })

  it('keeps unsupported providers closed', () => {
    for (const provider of ['cursor', 'ollama'] as const) {
      const adapter = getOrchestratorAdapter(provider)
      expect(adapter.capability.supported).toBe(false)
      expect(adapter.buildArgs(context)).toEqual([])
    }
  })
})
