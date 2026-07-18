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
  getMcpHandle,
  SUBAGENT_ALLOWED_TOOLS,
  SUBAGENT_MCP_SERVER_NAME,
  subagentToolName
} from '@main/orchestrator/mcpHandle'
import {
  buildClaudeMcpArgs,
  buildCodexMcpArgs,
  buildKimiMcpArgs,
  type McpServerSpec
} from '@main/orchestrator/mcpConfig'

/** Task scope for the per-worker Orca subagent MCP session. */
export interface SubagentMcpContext {
  taskId?: string
  engineId?: string
  workspaceSessionId?: string
  /** Claude/Kimi print-mode only: route unresolved tool prompts to Orca's broker. */
  permissionPrompt?: boolean
}

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
 * The Vertragus subagent server (report_progress / post_finding / list_findings)
 * scoped to one running task, or undefined when the Vertragus MCP server is not
 * up or no task scope was provided.
 */
function subagentServerSpec(context: SubagentMcpContext): McpServerSpec | undefined {
  const base = getMcpHandle()?.subagentUrl
  if (!base || !context.taskId) return undefined
  const url = new URL(base)
  url.searchParams.set('subagentTask', context.taskId)
  if (context.workspaceSessionId) url.searchParams.set('workspaceSession', context.workspaceSessionId)
  if (context.engineId) url.searchParams.set('engineId', context.engineId)
  return {
    name: SUBAGENT_MCP_SERVER_NAME,
    transport: 'http',
    url: url.toString(),
    allowedTools: SUBAGENT_ALLOWED_TOOLS.filter(
      (tool) => context.permissionPrompt || tool !== subagentToolName('permission_prompt')
    ),
    // These status/reporting tools are Vertragus-owned and task-scoped.
    approvalMode: 'approve'
  }
}

/**
 * True when a dispatched worker of this provider will get the Vertragus subagent
 * tools attached — used to decide whether the execution contract should
 * mention them.
 */
export function subagentOrcaToolsAvailable(provider: AgentProviderId): boolean {
  return providerSupportsExternalMcp(provider) && Boolean(getMcpHandle()?.subagentUrl)
}

/**
 * Extra CLI args that attach the external MCP servers scoped to a subagent
 * (interactive subwindow or headless dispatch), plus — for headless tasks with
 * a task scope — the Vertragus subagent report/finding tools. Returns `[]` for
 * providers without MCP support or when nothing is configured.
 */
export function buildSubagentMcpArgs(
  provider: AgentProviderId,
  agentId: string,
  context: SubagentMcpContext = {}
): string[] {
  if (!providerSupportsExternalMcp(provider)) return []
  const subagentServer = subagentServerSpec(context)
  const servers = [
    ...(subagentServer ? [subagentServer] : []),
    ...externalMcpSpecsFor('subagent', provider)
  ]
  if (servers.length === 0) return []
  if (provider === 'claude' || provider === 'kimi') {
    // strict=false so the subagent keeps its own personal .mcp.json servers too.
    // Kimi Code CLI mirrors Claude's per-subagent MCP + permission-prompt wiring,
    // differing only in the config-file flag handled by the builder.
    const build = provider === 'kimi' ? buildKimiMcpArgs : buildClaudeMcpArgs
    const args = build(servers, {
      configDir: app.getPath('userData'),
      fileTag: agentId,
      strict: false,
      includeReadonlyTools: false
    })
    if (context.permissionPrompt && subagentServer) {
      args.push('--permission-prompt-tool', subagentToolName('permission_prompt'))
    }
    return args
  }
  if (provider === 'codex') {
    return buildCodexMcpArgs(servers, {})
  }
  return []
}
