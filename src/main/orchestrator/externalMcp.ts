/**
 * Bridges the user-configured external MCP servers (persisted in the config
 * store) into the per-agent launch arguments. The orchestrator merges its
 * scoped servers into the Orca adapter; subagents (interactive + headless) get
 * their scoped servers attached directly here.
 *
 * When no servers are configured, every function returns an empty result so
 * agent launches are byte-for-byte identical to before this feature existed.
 */
import { app } from 'electron'
import type { AgentProviderId } from '@shared/providers'
import {
  isMcpServerComplete,
  mcpScopeMatches,
  providerSupportsExternalMcp,
  type McpServerConfig
} from '@shared/mcp'
import { listMcpServers } from '@main/config/store'
import {
  buildClaudeMcpArgs,
  buildCodexMcpArgs,
  type McpServerSpec
} from '@main/orchestrator/mcpConfig'

/** Turn a stored config into a launch spec, dropping empty optional fields. */
function toSpec(config: McpServerConfig): McpServerSpec {
  if (config.transport === 'stdio') {
    return {
      name: config.name,
      transport: 'stdio',
      command: config.command,
      args: config.args.length > 0 ? config.args : undefined,
      env: Object.keys(config.env).length > 0 ? config.env : undefined
    }
  }
  return {
    name: config.name,
    transport: config.transport,
    url: config.url,
    headers: Object.keys(config.headers).length > 0 ? config.headers : undefined
  }
}

/**
 * The complete, enabled external servers a given agent should receive, as
 * launch specs. Filters by enable flag, scope, provider support and
 * transport-completeness, and de-duplicates by name (last one wins).
 */
export function externalMcpSpecsFor(
  kind: 'orchestrator' | 'subagent',
  provider: AgentProviderId
): McpServerSpec[] {
  if (!providerSupportsExternalMcp(provider)) return []
  const byName = new Map<string, McpServerSpec>()
  for (const server of listMcpServers()) {
    if (!server.enabled) continue
    if (!mcpScopeMatches(server.scope, kind)) continue
    if (!isMcpServerComplete(server)) continue
    byName.set(server.name, toSpec(server))
  }
  return [...byName.values()]
}

/**
 * Extra CLI args that attach the external MCP servers scoped to a subagent
 * (interactive subwindow or headless dispatch). Returns `[]` for providers
 * without MCP support or when nothing is configured.
 */
export function buildSubagentMcpArgs(provider: AgentProviderId, agentId: string): string[] {
  const servers = externalMcpSpecsFor('subagent', provider)
  if (servers.length === 0) return []
  if (provider === 'claude') {
    // strict=false so the subagent keeps its own personal .mcp.json servers too.
    return buildClaudeMcpArgs(servers, {
      configDir: app.getPath('userData'),
      fileTag: agentId,
      strict: false,
      includeReadonlyTools: false
    })
  }
  if (provider === 'codex') {
    return buildCodexMcpArgs(servers, {})
  }
  return []
}
