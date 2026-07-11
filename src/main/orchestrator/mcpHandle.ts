/**
 * Leaf module holding the running MCP server handle. Kept dependency-free so
 * both the server (which sets it) and the agent launcher (which reads it) can
 * import it without creating a cycle through the engine/agent manager.
 */
export interface McpServerHandle {
  url: string
  allowedTools: string[]
  close(): Promise<void>
}

let handle: McpServerHandle | null = null

export function setMcpHandle(h: McpServerHandle | null): void {
  handle = h
}

export function getMcpHandle(): McpServerHandle | null {
  return handle
}
