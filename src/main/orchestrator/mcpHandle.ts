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
 * MCP config key the orchestrator server is attached under. Like the subagent
 * name below, the label is purely client-side (Vertragus regenerates the launch
 * config and the prompts that teach the tool names on every start), so the
 * rename from the legacy `orca` needs no runtime alias.
 */
export const ORCHESTRATOR_MCP_SERVER_NAME = 'vertragus'

/**
 * Bare names of the tools an Efficiency-Solo agent gets. The solo MCP session
 * (VertragusMcpServer.buildSoloMcpServer) registers exactly these; an
 * invariant test asserts the set-equality. Kept here so the launch side
 * (soloLaunch.ts → AgentManager) never has to import the server module.
 */
export const SOLO_TOOL_NAMES = ['report_activity', 'record_retro'] as const

/** Fully-qualified solo tool names for the provider launch allowlist. */
export const SOLO_ALLOWED_TOOLS = SOLO_TOOL_NAMES.map(
  (tool) => `mcp__${ORCHESTRATOR_MCP_SERVER_NAME}__${tool}`
)

/**
 * MCP config key the per-worker subagent server is attached under. The CLI
 * namespaces every tool as `mcp__<serverName>__<tool>`, so this single constant
 * drives both the launch spec name and the allow-list below. The label is
 * purely client-side (the server matches bare tool names), so renaming it from
 * the legacy `orca-sub` needs no runtime alias.
 */
export const SUBAGENT_MCP_SERVER_NAME = 'vertragus-sub'

const SUBAGENT_TOOL_NAMES = [
  'report_progress',
  'post_finding',
  'list_findings',
  'ask_orchestrator',
  'await_orchestrator_response',
  'permission_prompt'
] as const

/** Tools exposed to headless subagents (namespaced under `vertragus-sub`). */
export const SUBAGENT_ALLOWED_TOOLS = SUBAGENT_TOOL_NAMES.map(
  (tool) => `mcp__${SUBAGENT_MCP_SERVER_NAME}__${tool}`
)

/** Fully-qualified name of the permission-prompt tool for print-mode launches. */
export const SUBAGENT_PERMISSION_PROMPT_TOOL = `mcp__${SUBAGENT_MCP_SERVER_NAME}__permission_prompt`

let handle: McpServerHandle | null = null

export function setMcpHandle(h: McpServerHandle | null): void {
  handle = h
}

export function getMcpHandle(): McpServerHandle | null {
  return handle
}
