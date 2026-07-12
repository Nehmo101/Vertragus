/**
 * Provider-specific MCP launch-argument builders.
 *
 * A single normalized {@link McpServerSpec} list drives both the orchestrator's
 * Orca server and any user-configured external servers, for both Claude and
 * Codex. Kept free of Electron imports so it stays unit-testable — the only
 * side effect is writing Claude's `--mcp-config` file into a caller-provided
 * directory.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** A provider-agnostic MCP server description. */
export interface McpServerSpec {
  /** MCP key / tool namespace (`mcp__<name>__<tool>`). */
  name: string
  transport: 'stdio' | 'http' | 'sse'
  // http / sse
  url?: string
  headers?: Record<string, string>
  // stdio
  command?: string
  args?: string[]
  env?: Record<string, string>
  /**
   * Explicit tool allowlist (fully-qualified `mcp__<name>__<tool>` names).
   * `undefined` means allow every tool the server exposes.
   */
  allowedTools?: string[]
  /** Codex only: mark the server as required (startup fails if unreachable). */
  required?: boolean
}

export interface ClaudeMcpOptions {
  /** Directory the `--mcp-config` JSON file is written into. */
  configDir: string
  /** Unique suffix so concurrently-spawned agents never share a config file. */
  fileTag: string
  /** Pass `--strict-mcp-config` so ONLY these servers are used (orchestrator). */
  strict: boolean
  /** Appended verbatim via `--append-system-prompt` when present. */
  systemPrompt?: string
  /** Pre-approve Claude's read-only tools too (orchestrator). */
  includeReadonlyTools?: boolean
}

export interface CodexMcpOptions {
  /** Set as process-local `developer_instructions` when present. */
  systemPrompt?: string
}

/** Read-only Claude built-ins the orchestrator may use without a prompt. */
export const READONLY_CLAUDE_TOOLS = ['Read', 'Glob', 'Grep', 'TodoWrite']

/** JSON basic strings carry the escaping TOML needs for these scalar values. */
function tomlString(value: string): string {
  return JSON.stringify(value)
}

/** Strip the `mcp__<server>__` prefix to get Codex's bare enabled-tool name. */
function bareToolName(serverName: string, tool: string): string {
  return tool.replace(new RegExp(`^mcp__${serverName}__`), '')
}

/** Map one spec to a Claude `mcpServers` config entry. */
export function toClaudeServerConfig(spec: McpServerSpec): Record<string, unknown> {
  if (spec.transport === 'stdio') {
    const entry: Record<string, unknown> = { command: spec.command ?? '' }
    if (spec.args && spec.args.length > 0) entry.args = spec.args
    if (spec.env && Object.keys(spec.env).length > 0) entry.env = spec.env
    return entry
  }
  const entry: Record<string, unknown> = { type: spec.transport, url: spec.url ?? '' }
  if (spec.headers && Object.keys(spec.headers).length > 0) entry.headers = spec.headers
  return entry
}

/** The full `{ mcpServers: { … } }` object Claude expects. */
export function toClaudeMcpConfig(servers: McpServerSpec[]): { mcpServers: Record<string, unknown> } {
  const mcpServers: Record<string, unknown> = {}
  for (const spec of servers) mcpServers[spec.name] = toClaudeServerConfig(spec)
  return { mcpServers }
}

/**
 * The `--allowedTools` list: each server's explicit allowlist, or a
 * server-wide `mcp__<name>` wildcard when it exposes all tools.
 */
export function claudeAllowedTools(servers: McpServerSpec[], includeReadonly: boolean): string[] {
  const tools = servers.flatMap((spec) => spec.allowedTools ?? [`mcp__${spec.name}`])
  return includeReadonly ? [...tools, ...READONLY_CLAUDE_TOOLS] : tools
}

/** Build Claude CLI args, writing the merged `--mcp-config` file as a side effect. */
export function buildClaudeMcpArgs(servers: McpServerSpec[], opts: ClaudeMcpOptions): string[] {
  if (servers.length === 0) return []
  const dir = join(opts.configDir, 'orca-mcp')
  mkdirSync(dir, { recursive: true })
  const configPath = join(dir, `${opts.fileTag}.json`)
  writeFileSync(configPath, JSON.stringify(toClaudeMcpConfig(servers), null, 2))

  const args = ['--mcp-config', configPath]
  if (opts.strict) args.push('--strict-mcp-config')
  if (opts.systemPrompt) args.push('--append-system-prompt', opts.systemPrompt)
  args.push('--allowedTools', claudeAllowedTools(servers, opts.includeReadonlyTools ?? false).join(','))
  return args
}

/** Build the process-local `-c` overrides Codex needs for one server. */
export function codexServerArgs(spec: McpServerSpec): string[] {
  const key = `mcp_servers.${spec.name}`
  const args: string[] = []
  if (spec.transport === 'stdio') {
    args.push('-c', `${key}.command=${tomlString(spec.command ?? '')}`)
    if (spec.args && spec.args.length > 0) args.push('-c', `${key}.args=${JSON.stringify(spec.args)}`)
    for (const [name, value] of Object.entries(spec.env ?? {})) {
      args.push('-c', `${key}.env.${name}=${tomlString(value)}`)
    }
  } else {
    args.push('-c', `${key}.url=${tomlString(spec.url ?? '')}`)
  }
  if (spec.required) args.push('-c', `${key}.required=true`)
  if (spec.allowedTools) {
    const bare = spec.allowedTools.map((tool) => bareToolName(spec.name, tool))
    args.push('-c', `${key}.enabled_tools=${JSON.stringify(bare)}`)
  }
  return args
}

/** Build all process-local Codex overrides for a set of servers (+ instructions). */
export function buildCodexMcpArgs(servers: McpServerSpec[], opts: CodexMcpOptions): string[] {
  const args: string[] = []
  if (opts.systemPrompt) args.push('-c', `developer_instructions=${tomlString(opts.systemPrompt)}`)
  for (const spec of servers) args.push(...codexServerArgs(spec))
  return args
}
