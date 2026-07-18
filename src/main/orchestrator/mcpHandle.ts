/**
 * Leaf module holding the running MCP server handle. Kept dependency-free so
 * both the server (which sets it) and the agent launcher (which reads it) can
 * import it without creating a cycle through the engine/agent manager.
 */
export interface McpServerHandle {
  url: string
  allowedTools: string[]
  /**
   * Base URL for subagent sessions (separate token; exposes only the
   * report/finding tools). Callers append their task scope as query params.
   */
  subagentUrl?: string
  close(): Promise<void>
}

/**
 * MCP server key under which the subagent report/finding tools are exposed.
 * Product-controlled identifier; the `mcp__<server>__<tool>` names below and the
 * server registration in OrcaMcpServer.ts / externalMcp.ts all derive from it,
 * so they can never drift apart.
 */
export const SUBAGENT_MCP_SERVER_NAME = 'vertragus-sub'

/** Bare tool names the subagent server advertises (without the mcp prefix). */
export const SUBAGENT_TOOL_NAMES = [
  'report_progress',
  'post_finding',
  'list_findings',
  'ask_orchestrator',
  'await_orchestrator_response',
  'permission_prompt'
] as const

/** Fully-qualified name of a subagent tool as seen by the provider CLI. */
export function subagentToolName(tool: string): string {
  return `mcp__${SUBAGENT_MCP_SERVER_NAME}__${tool}`
}

/** Tools exposed to headless subagents (namespaced under the server key above). */
export const SUBAGENT_ALLOWED_TOOLS = SUBAGENT_TOOL_NAMES.map(subagentToolName)

let handle: McpServerHandle | null = null

export function setMcpHandle(h: McpServerHandle | null): void {
  handle = h
}

export function getMcpHandle(): McpServerHandle | null {
  return handle
}
