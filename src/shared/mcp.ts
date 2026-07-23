/**
 * External MCP server definitions shared across main / preload / renderer.
 *
 * These are user-configured Model-Context-Protocol servers (e.g. a filesystem,
 * database or web-search server) that Vertragus attaches to the agents it
 * launches, so every agent — the orchestrator and the individual subagents —
 * can see and use their tools. Pure data + zod only; no Node.js imports so the
 * renderer can import it too.
 */
import { z } from 'zod'
import type { AgentProviderId } from './providers'

/** How Vertragus talks to the MCP server. */
export const MCP_TRANSPORTS = ['stdio', 'http', 'sse'] as const
export type McpTransport = (typeof MCP_TRANSPORTS)[number]

/** Which agents a configured server is attached to. */
export const MCP_SCOPES = ['all', 'orchestrator', 'subagents'] as const
export type McpScope = (typeof MCP_SCOPES)[number]

export const MCP_TRANSPORT_LABELS: Record<McpTransport, string> = {
  stdio: 'Lokaler Prozess (stdio)',
  http: 'HTTP (Streamable)',
  sse: 'SSE (Server-Sent Events)'
}

export const MCP_SCOPE_LABELS: Record<McpScope, string> = {
  all: 'Alle Agents',
  orchestrator: 'Nur Orchestrator',
  subagents: 'Nur Subagents'
}

/**
 * The server `name` becomes the MCP config key and the tool namespace
 * (`mcp__<name>__<tool>`), so it must be a safe bare identifier.
 */
export const MCP_NAME_PATTERN = /^[A-Za-z0-9_-]{1,48}$/

/**
 * Names of the in-app Vertragus MCP servers (current + legacy). An external
 * server under one of these keys would silently shadow the internal
 * orchestrator/subagent server in the generated launch config (last one wins),
 * so they are rejected at validation and filtered defensively at launch.
 */
export const RESERVED_MCP_SERVER_NAMES = ['vertragus', 'vertragus-sub', 'orca', 'orca-sub'] as const

export function isReservedMcpServerName(name: string): boolean {
  return (RESERVED_MCP_SERVER_NAMES as readonly string[]).includes(name.toLowerCase())
}

export const mcpServerSchema = z.object({
  id: z.string().min(1),
  /** Bare identifier used as the MCP key / tool namespace. */
  name: z
    .string()
    .regex(MCP_NAME_PATTERN, 'Nur Buchstaben, Zahlen, _ und - (max. 48 Zeichen).')
    .refine((name) => !isReservedMcpServerName(name), {
      message: 'Dieser Name ist für die internen Vertragus-Server reserviert.'
    }),
  /** Disabled servers are kept but never attached to an agent. */
  enabled: z.boolean().default(true),
  transport: z.enum(MCP_TRANSPORTS).default('stdio'),
  scope: z.enum(MCP_SCOPES).default('all'),
  // stdio transport
  command: z.string().default(''),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  // http / sse transport
  url: z.string().default(''),
  headers: z.record(z.string(), z.string()).default({})
})

export type McpServerConfig = z.infer<typeof mcpServerSchema>

export const mcpServersSchema = z.array(mcpServerSchema)

/** Claude, Kimi and Codex have verified per-agent MCP wiring today. */
export function providerSupportsExternalMcp(provider: AgentProviderId): boolean {
  return provider === 'claude' || provider === 'kimi' || provider === 'codex'
}

/**
 * Whether a dispatched worker of this provider can receive the Vertragus subagent
 * reporting tools (report_progress / post_finding / list_findings /
 * ask_orchestrator). These ride the same per-agent MCP channel, so support is
 * currently identical to {@link providerSupportsExternalMcp}. Cursor, Copilot
 * and Ollama have no verified, transient per-process MCP config, so they return
 * false — the orchestrator must not require these tools from those workers, and
 * their absence is a known capability gap, not a model failure.
 */
export function providerSupportsSubagentReporting(provider: AgentProviderId): boolean {
  return providerSupportsExternalMcp(provider)
}

/** Does a server's scope include the given agent kind? */
export function mcpScopeMatches(scope: McpScope, kind: 'orchestrator' | 'subagent'): boolean {
  if (scope === 'all') return true
  if (scope === 'orchestrator') return kind === 'orchestrator'
  return kind === 'subagent'
}

/**
 * A server config is only usable once its transport-specific target is filled
 * in: stdio needs a command, http/sse need a URL.
 */
export function isMcpServerComplete(server: McpServerConfig): boolean {
  if (!MCP_NAME_PATTERN.test(server.name)) return false
  if (isReservedMcpServerName(server.name)) return false
  return server.transport === 'stdio'
    ? server.command.trim().length > 0
    : server.url.trim().length > 0
}

/** A fresh, empty stdio server with a generated id (for the editor UI). */
export function emptyMcpServer(id: string): McpServerConfig {
  return {
    id,
    name: '',
    enabled: true,
    transport: 'stdio',
    scope: 'all',
    command: '',
    args: [],
    env: {},
    url: '',
    headers: {}
  }
}
