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

/** Tools exposed to headless subagents (namespaced under the `orca-sub` key). */
export const SUBAGENT_ALLOWED_TOOLS = [
  'mcp__orca-sub__report_progress',
  'mcp__orca-sub__post_finding',
  'mcp__orca-sub__list_findings',
  'mcp__orca-sub__ask_orchestrator',
  'mcp__orca-sub__await_orchestrator_response',
  'mcp__orca-sub__permission_prompt'
]

let handle: McpServerHandle | null = null

export function setMcpHandle(h: McpServerHandle | null): void {
  handle = h
}

export function getMcpHandle(): McpServerHandle | null {
  return handle
}
