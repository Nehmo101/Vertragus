/**
 * Provider-specific MCP launch-argument builders.
 *
 * A single normalized {@link McpServerSpec} list drives both the orchestrator's
 * Vertragus server and any user-configured external servers, for both Claude and
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
  /** Codex only: process-local approval policy for tools exposed by this server. */
  approvalMode?: 'auto' | 'prompt' | 'writes' | 'approve'
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

/**
 * Shared Anthropic-style arg builder for Claude Code and the Kimi Code CLI,
 * which differ only in the flag that points at the merged MCP config file.
 * Writes that file into a caller-provided directory as the single side effect.
 */
function buildAnthropicStyleMcpArgs(
  servers: McpServerSpec[],
  opts: ClaudeMcpOptions,
  configFlag: string
): string[] {
  if (servers.length === 0) return []
  const dir = join(opts.configDir, 'orca-mcp')
  mkdirSync(dir, { recursive: true })
  const configPath = join(dir, `${opts.fileTag}.json`)
  writeFileSync(configPath, JSON.stringify(toClaudeMcpConfig(servers), null, 2))

  const args = [configFlag, configPath]
  if (opts.strict) args.push('--strict-mcp-config')
  if (opts.systemPrompt) args.push('--append-system-prompt', opts.systemPrompt)
  args.push('--allowedTools', claudeAllowedTools(servers, opts.includeReadonlyTools ?? false).join(','))
  return args
}

/** Build Claude CLI args, writing the merged `--mcp-config` file as a side effect. */
export function buildClaudeMcpArgs(servers: McpServerSpec[], opts: ClaudeMcpOptions): string[] {
  return buildAnthropicStyleMcpArgs(servers, opts, '--mcp-config')
}

/**
 * Build Kimi Code CLI args. Kimi accepts the merged MCP config through
 * `--mcp-config-file` and otherwise mirrors Claude Code's flag surface
 * (`--strict-mcp-config`, `--append-system-prompt`, `--allowedTools`), so it
 * reuses the same config writer, allow-list helper and options type.
 */
export function buildKimiMcpArgs(servers: McpServerSpec[], opts: ClaudeMcpOptions): string[] {
  return buildAnthropicStyleMcpArgs(servers, opts, '--mcp-config-file')
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
  if (spec.approvalMode) {
    args.push('-c', `${key}.default_tools_approval_mode=${tomlString(spec.approvalMode)}`)
  }
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

/** Map one normalized server to GitHub Copilot CLI's transient JSON format. */
export function toCopilotServerConfig(spec: McpServerSpec): Record<string, unknown> {
  const tools = spec.allowedTools?.map((tool) => bareToolName(spec.name, tool)) ?? ['*']
  if (spec.transport === 'stdio') {
    const entry: Record<string, unknown> = { type: 'stdio', command: spec.command ?? '', tools }
    if (spec.args && spec.args.length > 0) entry.args = spec.args
    if (spec.env && Object.keys(spec.env).length > 0) entry.env = spec.env
    return entry
  }
  const entry: Record<string, unknown> = { type: spec.transport, url: spec.url ?? '', tools }
  if (spec.headers && Object.keys(spec.headers).length > 0) entry.headers = spec.headers
  return entry
}

export function toCopilotMcpConfig(servers: McpServerSpec[]): {
  mcpServers: Record<string, unknown>
} {
  const mcpServers: Record<string, unknown> = {}
  for (const spec of servers) mcpServers[spec.name] = toCopilotServerConfig(spec)
  return { mcpServers }
}

/**
 * Copilot CLI accepts a JSON object through --additional-mcp-config for one
 * process only. Explicit Vertragus tools are pre-approved without enabling every
 * built-in tool or URL.
 */
export function buildCopilotMcpArgs(servers: McpServerSpec[]): string[] {
  if (servers.length === 0) return []
  const args = [
    '--additional-mcp-config',
    JSON.stringify(toCopilotMcpConfig(servers)),
    '--allow-all-mcp-server-instructions'
  ]
  const allowedTools = servers.flatMap((spec) =>
    (spec.allowedTools ?? []).map((tool) => `${spec.name}(${bareToolName(spec.name, tool)})`)
  )
  if (allowedTools.length > 0) args.push('--allow-tool', allowedTools.join(','))
  return args
}
