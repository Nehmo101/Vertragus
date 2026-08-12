/**
 * Attaching the Vertragus MCP server to an agent CLI.
 *
 * Distilled from the old repo's `mcpConfig.ts`: one server, HTTP transport,
 * three provider dialects. The rule that survives unchanged is "every spawn
 * attaches" — the old repo shipped a second spawn path that forgot the config
 * and produced interactive subagents with no way to report back. Callers
 * therefore build args through these functions only.
 *
 * The three dialects are genuinely different in kind, and pretending otherwise
 * is what makes launches fail with an unknown flag:
 *
 * - **Claude** takes a transient JSON file (`--mcp-config`) and can be locked
 *   to it (`--strict-mcp-config`).
 * - **Codex** has no file flag at all: every setting is a process-local
 *   `-c key=value` TOML override, including the system prompt
 *   (`developer_instructions`). Nothing is written to `~/.codex/config.toml`.
 * - **Kimi** has neither: it reads `<cwd>/.kimi-code/mcp.json`, so the
 *   attachment is a file in the AGENT'S WORKING DIRECTORY, and its system
 *   prompt arrives as a `--agent-file` markdown profile.
 *
 * Every flag and key below was verified against the CLIs installed on this
 * machine (claude, codex-cli 0.144.6, kimi 0.34.0) — not from documentation.
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

/**
 * The orchestrator's tools ON THIS SERVER, fully qualified.
 *
 * Kept apart from {@link orchestratorAllowedTools} because the two allowlists
 * are different in kind: Claude's `--allowedTools` is process-wide (so the
 * read-only built-ins belong in it), while Codex' `enabled_tools` and Kimi's
 * `enabledTools` are PER MCP SERVER — putting `Read` in either would declare a
 * tool our server does not expose.
 */
export function orchestratorMcpTools(): string[] {
  return ORCHESTRATOR_TOOL_NAMES.map(qualifiedToolName)
}

/** The orchestrator's complete allowlist: its six tools plus read-only built-ins. */
export function orchestratorAllowedTools(): string[] {
  return [...orchestratorMcpTools(), ...READONLY_CLAUDE_TOOLS]
}

/** `mcp__vertragus__start_agent` → `start_agent`. Codex and Kimi want bare names. */
export function bareToolName(tool: string): string {
  const prefix = `mcp__${MCP_SERVER_NAME}__`
  return tool.startsWith(prefix) ? tool.slice(prefix.length) : tool
}

/**
 * A per-server allowlist from a process-wide one: everything outside our
 * namespace is DROPPED, not renamed. `Read` in `enabled_tools` would name a
 * tool the Vertragus server does not have — which is how a server-scoped
 * allowlist turns into a silently empty one.
 */
export function serverScopedTools(
  allowedTools: readonly string[] | undefined
): string[] | undefined {
  if (!allowedTools) return undefined
  const prefix = `mcp__${MCP_SERVER_NAME}__`
  return allowedTools.filter((tool) => tool.startsWith(prefix)).map(bareToolName)
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
  // Attach first, prompt last — the same order `agents/spawn` composes, so the
  // two routes stay comparable argument for argument (see its drift test).
  if (target.allowedTools && target.allowedTools.length > 0) {
    args.push('--allowedTools', target.allowedTools.join(','))
  }
  if (target.systemPrompt?.trim()) args.push('--append-system-prompt', target.systemPrompt)
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

// --- Codex ---------------------------------------------------------------

/**
 * Codex has no config-FILE flag. Everything is a process-local `-c key=value`
 * override whose value is parsed as TOML, so nothing is ever written to the
 * user's `~/.codex/config.toml`.
 *
 * Verified against codex-cli 0.144.6 on this machine with
 * `codex -c mcp_servers.vertragus.url=… mcp list`, which lists the injected
 * server next to the user's own — see the note on {@link buildCodexMcpArgs}.
 */
export const CODEX_CONFIG_FLAG = '-c'

/**
 * A TOML scalar. A JSON basic string carries exactly the escaping TOML needs
 * (quotes, backslashes, `\n`), which is what makes a multi-line system prompt
 * survive `-c developer_instructions=…` unmangled.
 */
export function tomlString(value: string): string {
  return JSON.stringify(value)
}

/**
 * The process-local overrides that attach our server to one Codex launch.
 *
 * `required=true` is the fail-closed half of "every spawn attaches": a Codex
 * that cannot reach the Vertragus server must refuse to start instead of coming
 * up as a mute agent. `default_tools_approval_mode="approve"` pre-approves this
 * server's tools only — it is a loopback server Vertragus minted seconds ago,
 * and an approval prompt on `report_done` would deadlock the agent.
 */
export function codexServerOverrides(url: string, allowedTools?: readonly string[]): string[] {
  const key = `mcp_servers.${MCP_SERVER_NAME}`
  const args = [
    CODEX_CONFIG_FLAG,
    `${key}.url=${tomlString(url)}`,
    CODEX_CONFIG_FLAG,
    `${key}.required=true`,
    CODEX_CONFIG_FLAG,
    `${key}.default_tools_approval_mode=${tomlString('approve')}`
  ]
  const tools = serverScopedTools(allowedTools)
  if (tools) args.push(CODEX_CONFIG_FLAG, `${key}.enabled_tools=${JSON.stringify(tools)}`)
  return args
}

/**
 * Codex launch arguments for the MCP attachment.
 *
 * KNOWN LIMIT, and deliberately not papered over: Codex has no
 * `--strict-mcp-config`. `-c mcp_servers=…` MERGES with the user's config
 * (verified: `-c 'mcp_servers={}'` does not clear it), so a Codex orchestrator
 * also sees whatever MCP servers the user configured themselves. Our own server
 * is still scoped by `enabled_tools`; the user's are not ours to switch off.
 */
export function buildCodexMcpArgs(target: McpAttachTarget): string[] {
  return codexServerOverrides(target.url, target.allowedTools)
}

/**
 * Codex' system prompt: `developer_instructions`, not an Anthropic-style flag.
 * This is the whole of `systemPromptDelivery: 'codex-config'`.
 */
export function codexDeveloperInstructionsArgs(systemPrompt: string | undefined): string[] {
  const prompt = systemPrompt?.trim()
  if (!prompt) return []
  return [CODEX_CONFIG_FLAG, `developer_instructions=${tomlString(prompt)}`]
}

/** Codex args for an orchestrator: server-scoped allowlist + instructions. */
export function buildCodexOrchestratorArgs(
  target: Omit<McpAttachTarget, 'allowedTools'>
): string[] {
  return [
    ...buildCodexMcpArgs({ ...target, allowedTools: orchestratorMcpTools() }),
    ...codexDeveloperInstructionsArgs(target.systemPrompt)
  ]
}

/**
 * Codex args for a subagent: attached, unrestricted. Same reasoning as the
 * Claude path — a worker's discipline comes from its task contract.
 */
export function buildCodexSubagentArgs(
  target: Omit<McpAttachTarget, 'allowedTools'>
): string[] {
  return [
    ...buildCodexMcpArgs({ ...target, allowedTools: undefined }),
    ...codexDeveloperInstructionsArgs(target.systemPrompt)
  ]
}

// --- Kimi Code -----------------------------------------------------------

/**
 * Kimi Code has NO MCP flag at all. Verified against kimi 0.34.0: `kimi --help`
 * lists no `--mcp-config`/`--mcp-config-file`, and the CLI's own bundled
 * migration skill states the rule outright — "Project-local MCP:
 * `<cwd>/.kimi-code/mcp.json`, because Kimi reads the current working
 * directory's Kimi-specific MCP file". So the attachment IS a file in the agent
 * working directory, which is why this path needs the cwd and why a worktree
 * agent gets its config inside the worktree.
 */
export const KIMI_PROJECT_DIR = '.kimi-code'
export const KIMI_MCP_FILE = 'mcp.json'

/**
 * The flag that swaps Kimi's default system prompt for ours. Also verified in
 * 0.34.0: `--agent-file <path>` "Cannot be combined with --session/--continue",
 * hence {@link withoutKimiAgentFileArgs}.
 */
export const KIMI_AGENT_FILE_FLAG = '--agent-file'

/**
 * Kimi's agent profile id. Its parser requires a kebab-case `name` and a
 * non-empty `description`, and falls back to the FILE NAME when `name` is
 * missing — our file names are `sub-<uuid>.agent.md`, which is not kebab-case,
 * so the field is mandatory here in practice.
 */
export const KIMI_AGENT_NAME = 'vertragus-agent'
export const KIMI_AGENT_DESCRIPTION = 'Vertragus agent profile for this launch'

/** One `mcpServers` entry as Kimi reads it: a bare `url` means HTTP. */
export function toKimiMcpConfig(
  url: string,
  allowedTools?: readonly string[]
): { mcpServers: Record<string, unknown> } {
  const entry: Record<string, unknown> = { url }
  const tools = serverScopedTools(allowedTools)
  if (tools) entry.enabledTools = tools
  return { mcpServers: { [MCP_SERVER_NAME]: entry } }
}

/** Fail closed: prove the project file we just wrote names our server. */
export function assertWrittenKimiMcpConfig(configPath: string): void {
  const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
  const servers = parsed.mcpServers as Record<string, { url?: string }> | undefined
  if (!servers || typeof servers !== 'object' || !servers[MCP_SERVER_NAME]?.url) {
    throw new Error(`Invalid Vertragus Kimi MCP config written to ${configPath}`)
  }
}

/**
 * Install `<workspaceDir>/.kimi-code/mcp.json`.
 *
 * This writes INTO THE AGENT'S WORKING DIRECTORY — the agent's own worktree.
 * The file is left behind on purpose
 * (Kimi re-reads it on every start, and deleting it under a running agent would
 * be worse than a stray file); see the module note in `agents/spawn`.
 *
 * Two Kimi agents sharing ONE working directory would share one file — the
 * second install would overwrite the first agent's personal URL. That cannot
 * happen in Vertragus: every agent runs in its own worktree, so every agent
 * has this file to itself.
 */
export function writeKimiProjectMcpConfig(
  url: string,
  workspaceDir: string,
  allowedTools?: readonly string[]
): string {
  const dir = join(workspaceDir, KIMI_PROJECT_DIR)
  mkdirSync(dir, { recursive: true })
  const configPath = join(dir, KIMI_MCP_FILE)
  writeFileSync(configPath, JSON.stringify(toKimiMcpConfig(url, allowedTools), null, 2))
  assertWrittenKimiMcpConfig(configPath)
  return configPath
}

/**
 * A Kimi agent file: YAML frontmatter plus the prompt as the body. The body
 * REPLACES Kimi's default system prompt for this launch — it is not appended,
 * which is the one behavioural difference to Claude's `--append-system-prompt`.
 */
export function kimiAgentFileText(systemPrompt: string): string {
  return [
    '---',
    `name: ${KIMI_AGENT_NAME}`,
    `description: ${KIMI_AGENT_DESCRIPTION}`,
    '---',
    '',
    systemPrompt.trim(),
    ''
  ].join('\n')
}

/** Write the agent file next to the other transient configs; return its path. */
export function writeKimiAgentFile(
  systemPrompt: string,
  configDir: string,
  fileTag: string
): string {
  const dir = join(configDir, 'vertragus-mcp')
  mkdirSync(dir, { recursive: true })
  const agentPath = join(dir, `${fileTag}.agent.md`)
  writeFileSync(agentPath, kimiAgentFileText(systemPrompt))
  return agentPath
}

/**
 * Kimi launch arguments: the MCP attachment is a file (so it contributes no
 * args), the system prompt is an agent file (so it contributes two).
 */
export function buildKimiMcpArgs(target: McpAttachTarget & { workspaceDir: string }): string[] {
  writeKimiProjectMcpConfig(target.url, target.workspaceDir, target.allowedTools)
  const prompt = target.systemPrompt?.trim()
  if (!prompt) return []
  return [KIMI_AGENT_FILE_FLAG, writeKimiAgentFile(prompt, target.configDir, target.fileTag)]
}

/** Kimi args for an orchestrator: server-scoped allowlist + agent file. */
export function buildKimiOrchestratorArgs(
  target: Omit<McpAttachTarget, 'allowedTools'> & { workspaceDir: string }
): string[] {
  return buildKimiMcpArgs({ ...target, allowedTools: orchestratorMcpTools() })
}

/** Kimi args for a subagent: attached, unrestricted. */
export function buildKimiSubagentArgs(
  target: Omit<McpAttachTarget, 'allowedTools'> & { workspaceDir: string }
): string[] {
  return buildKimiMcpArgs({ ...target, allowedTools: undefined })
}

/**
 * Drop `--agent-file <path>` pairs.
 *
 * Kimi rejects `--agent-file` together with `--session` / `--continue`: a
 * resumed session already carries its agent profile. Vertragus has no resume
 * path yet — this exists so the one that adds it cannot rediscover the
 * incompatibility the hard way.
 */
export function withoutKimiAgentFileArgs(args: readonly string[]): string[] {
  const out: string[] = []
  for (let index = 0; index < args.length; index++) {
    if (args[index] === KIMI_AGENT_FILE_FLAG) {
      index += 1
      continue
    }
    out.push(args[index]!)
  }
  return out
}
