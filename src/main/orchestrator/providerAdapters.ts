import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentProviderId } from '@shared/providers'
import type { OrchestratorProviderCapability } from '@shared/orchestrator'
import type { McpServerHandle } from '@main/orchestrator/mcpHandle'

export interface OrchestratorAdapterContext {
  name: string
  handle: McpServerHandle
  configDir: string
  systemPrompt: string
}

export interface OrchestratorAdapter {
  capability: OrchestratorProviderCapability
  buildArgs(context: OrchestratorAdapterContext): string[]
}

const READONLY_CLAUDE_TOOLS = ['Read', 'Glob', 'Grep', 'TodoWrite']

function tomlString(value: string): string {
  // JSON basic strings have the escaping needed by TOML for these values.
  return JSON.stringify(value)
}

function codexToolNames(handle: McpServerHandle): string[] {
  return handle.allowedTools.map((tool) => tool.replace(/^mcp__orca__/, ''))
}

const claudeAdapter: OrchestratorAdapter = {
  capability: {
    provider: 'claude',
    supported: true,
    transport: 'mcp-http',
    transientConfig: true
  },
  buildArgs({ handle, configDir, systemPrompt }) {
    const configPath = join(configDir, 'orca-mcp.json')
    writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: { orca: { type: 'http', url: handle.url } } }, null, 2)
    )
    const allowed = [...handle.allowedTools, ...READONLY_CLAUDE_TOOLS].join(',')
    return [
      '--mcp-config',
      configPath,
      '--strict-mcp-config',
      '--append-system-prompt',
      systemPrompt,
      '--allowedTools',
      allowed
    ]
  }
}

const codexAdapter: OrchestratorAdapter = {
  capability: {
    provider: 'codex',
    supported: true,
    transport: 'mcp-http',
    transientConfig: true
  },
  buildArgs({ handle, systemPrompt }) {
    const tools = codexToolNames(handle)
    // Every override is process-local. Nothing is written to ~/.codex/config.toml.
    return [
      '-c',
      `developer_instructions=${tomlString(systemPrompt)}`,
      '-c',
      `mcp_servers.orca.url=${tomlString(handle.url)}`,
      '-c',
      'mcp_servers.orca.required=true',
      '-c',
      `mcp_servers.orca.enabled_tools=${JSON.stringify(tools)}`
    ]
  }
}

function unsupported(provider: AgentProviderId): OrchestratorAdapter {
  return {
    capability: {
      provider,
      supported: false,
      transport: 'none',
      transientConfig: true,
      reason: 'Dieser Provider hat noch keinen verifizierten MCP-Orchestrator-Adapter.'
    },
    buildArgs: () => []
  }
}

const ADAPTERS: Record<AgentProviderId, OrchestratorAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  cursor: unsupported('cursor'),
  ollama: unsupported('ollama')
}

export function getOrchestratorAdapter(provider: AgentProviderId): OrchestratorAdapter {
  return ADAPTERS[provider]
}

export function listOrchestratorCapabilities(): OrchestratorProviderCapability[] {
  return Object.values(ADAPTERS).map((adapter) => ({ ...adapter.capability }))
}
