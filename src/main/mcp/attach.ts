/**
 * Attaching the Vertragus MCP server to an agent CLI.
 *
 * Distilled from the old repo's `mcpConfig.ts` down to what M2 needs: Claude
 * Code, HTTP transport, one server. The rule that survives unchanged is
 * "every spawn attaches" — the old repo shipped a second spawn path that
 * forgot the config and produced interactive subagents with no way to report
 * back. Callers therefore build args through these functions only.
 *
 * The orchestrator runs on a strict allowlist (its six tools plus Claude's
 * read-only built-ins) so it cannot start editing code itself. Subagents get NO
 * `--allowedTools` at all: they are meant to work, and restricting them is what
 * produced the "permission-starved" workers in the old retros.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MCP_SERVER_NAME } from './server'
import { ORCHESTRATOR_TOOL_NAMES } from './toolsOrchestrator'

/** Claude built-ins the orchestrator may use for verification without a prompt. */
export const READONLY_CLAUDE_TOOLS = ['Read', 'Glob', 'Grep', 'TodoWrite'] as const

/** Fully-qualified MCP tool names as the CLIs expect them in an allowlist. */
export function qualifiedToolName(tool: string): string {
  return `mcp__${MCP_SERVER_NAME}__${tool}`
}

/** The orchestrator's complete allowlist: its six tools plus read-only built-ins. */
export function orchestratorAllowedTools(): string[] {
  return [...ORCHESTRATOR_TOOL_NAMES.map(qualifiedToolName), ...READONLY_CLAUDE_TOOLS]
}

export interface McpAttachTarget {
  /** Full URL including `ws`, optional `agent` and `token` query parameters. */
  url: string
  /** Directory the transient config file is written into (per app, per run). */
  configDir: string
  /** Unique suffix so concurrently spawned agents never share a config file. */
  fileTag: string
  /** Appended verbatim via `--append-system-prompt`. */
  systemPrompt?: string
  /**
   * Explicit tool allowlist. Omit for subagents — they run unrestricted.
   */
  allowedTools?: string[]
}

/** The `{ mcpServers: { vertragus: … } }` object Claude expects. */
export function toClaudeMcpConfig(url: string): { mcpServers: Record<string, unknown> } {
  return { mcpServers: { [MCP_SERVER_NAME]: { type: 'http', url } } }
}

/** Fail closed: prove the file we just wrote is the shape Claude will read. */
export function assertWrittenClaudeMcpConfig(configPath: string): void {
  const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
  const servers = parsed.mcpServers as Record<string, { url?: string }> | undefined
  if (!servers || typeof servers !== 'object' || !servers[MCP_SERVER_NAME]?.url) {
    throw new Error(`Invalid Vertragus MCP config written to ${configPath}`)
  }
}

/** Write the transient config file and return its absolute path. */
export function writeClaudeMcpConfigFile(
  url: string,
  configDir: string,
  fileTag: string
): string {
  const dir = join(configDir, 'vertragus-mcp')
  mkdirSync(dir, { recursive: true })
  const configPath = join(dir, `${fileTag}.json`)
  writeFileSync(configPath, JSON.stringify(toClaudeMcpConfig(url), null, 2))
  assertWrittenClaudeMcpConfig(configPath)
  return configPath
}

/**
 * Claude Code launch arguments: transient MCP config, strict mode (only our
 * server), optional system prompt, optional allowlist.
 */
export function buildClaudeMcpArgs(target: McpAttachTarget): string[] {
  const configPath = writeClaudeMcpConfigFile(target.url, target.configDir, target.fileTag)
  const args = ['--mcp-config', configPath, '--strict-mcp-config']
  if (target.systemPrompt?.trim()) args.push('--append-system-prompt', target.systemPrompt)
  if (target.allowedTools && target.allowedTools.length > 0) {
    args.push('--allowedTools', target.allowedTools.join(','))
  }
  return args
}

/** Claude args for an orchestrator: strict allowlist, orchestrator system prompt. */
export function buildClaudeOrchestratorArgs(
  target: Omit<McpAttachTarget, 'allowedTools'>
): string[] {
  return buildClaudeMcpArgs({ ...target, allowedTools: orchestratorAllowedTools() })
}

/**
 * Claude args for a subagent: MCP attached, no allowlist. A worker must be able
 * to edit, run and commit; its discipline comes from the task contract, not
 * from a tool cage.
 */
export function buildClaudeSubagentArgs(
  target: Omit<McpAttachTarget, 'allowedTools' | 'systemPrompt'> & { systemPrompt?: string }
): string[] {
  return buildClaudeMcpArgs({ ...target, allowedTools: undefined })
}

/**
 * TODO(M5): Codex attaches process-locally via `-c mcp_servers.<name>.url=…`
 * plus `-c developer_instructions=…`; see the old repo's `codexServerArgs`.
 */
export function buildCodexMcpArgs(target: McpAttachTarget): string[] {
  void target
  throw new Error('Codex MCP attach lands in M5 (provider breadth)')
}

/**
 * TODO(M5): Kimi Code has no MCP flag — it discovers `.kimi-code/mcp.json` in
 * the agent working directory, and takes the system prompt via `--agent-file`.
 * Needs the agent cwd, hence the extra parameter.
 */
export function buildKimiMcpArgs(target: McpAttachTarget & { workspaceDir: string }): string[] {
  void target
  throw new Error('Kimi MCP attach lands in M5 (provider breadth)')
}
