/**
 * Attaching the Vertragus MCP server to an agent CLI.
 *
 * Distilled from the old repo's `mcpConfig.ts`: one server, HTTP transport,
 * five provider dialects. The rule that survives unchanged is "every spawn
 * attaches" — the old repo shipped a second spawn path that forgot the config
 * and produced interactive subagents with no way to report back. Callers
 * therefore build args through these functions only.
 *
 * The dialects are genuinely different in kind, and pretending otherwise is
 * what makes launches fail with an unknown flag:
 *
 * - **Claude** takes a transient JSON file (`--mcp-config`) and can be locked
 *   to it (`--strict-mcp-config`).
 * - **Codex** has no file flag at all: every setting is a process-local
 *   `-c key=value` TOML override, including the system prompt
 *   (`developer_instructions`). Nothing is written to `~/.codex/config.toml`.
 * - **Kimi** has neither: it reads `<cwd>/.kimi-code/mcp.json`, so the
 *   attachment is a file in the AGENT'S WORKING DIRECTORY, and its system
 *   prompt arrives as a `--agent-file` markdown profile.
 * - **Cursor** reads `<cwd>/.cursor/mcp.json` (or `~/.cursor/mcp.json`). There
 *   is no CLI flag that passes a server or config file (`cursor-agent mcp`
 *   has login/list/enable/disable — no `add`). Attachment is therefore a
 *   merge into the project file, plus `--approve-mcps` at launch. HTTP
 *   Streamable transport preserves the identity query string verbatim.
 * - **Grok Build** reads project `.grok/config.toml` (`[mcp_servers.<name>]`)
 *   and has no `--mcp-config` flag (Claude aliases cover `--append-system-prompt`
 *   / `--dangerously-skip-permissions`, not MCP). Attachment is a merge of the
 *   `vertragus` table into that file, plus `--allow MCPTool(vertragus__*)` so
 *   the loopback tools are usable without a TUI click. Grok also *scans*
 *   `.cursor/mcp.json` and `.mcp.json`, but those scanners can be switched off
 *   (`[compat.claude] mcps = false`); the native file cannot.
 *   The orchestrator also writes `[permission]` deny/allow: MCP tools are not
 *   auto-approved on Grok, and `--tools`/`--disallowed-tools` are headless-only
 *   (ignored in the interactive TUI). Native spawn is killed with
 *   `GROK_SUBAGENTS=0` / `--no-subagents` plus a project agent file; see spawn.
 *
 * Verified Cursor facts (cursor-agent 2026.08.11-e8db854 on this machine):
 * - Project file shape: `{ "mcpServers": { "<id>": { "url": "http://…" } } }`.
 * - Server approval is per-project-dir AND per-URL (hash covers the URL in
 *   `~/.cursor/projects/<slug>/mcp-approvals.json`), so a stored approval can
 *   never be reused across Vertragus agents — `--approve-mcps` is the only
 *   mechanism that scales. It also writes the approval entry itself.
 * - Tool-call approval is covered by `--force` / `--yolo` (preset yoloArgs).
 * - Workspace trust: a fresh directory blocks on a TUI modal before anything
 *   runs; the verified `--trust` flag suppresses it (preset `args`, not here).
 * - `cursor-agent mcp enable` works but crashes on teardown (libuv assert,
 *   exit 9) AFTER printing success — do not shell out to it for attach.
 * - No verified per-server tool filter (`enabledTools` / `--allowedTools`):
 *   orchestrator scoping stays URL-side (which tools the server exposes).
 *
 * Grok Build flags are taken from the published CLI / MCP / settings docs
 * (https://docs.x.ai/build/cli/reference, /features/mcp-servers,
 * /features/permissions). There is no `--strict-mcp-config` and no
 * per-server `enabled_tools` on `[mcp_servers.*]`. Subagent scoping stays
 * URL-side, same declared limit as Cursor. Orchestrator launches add a
 * permission cage because `--disallowed-tools` is ignored in the TUI.
 *
 * Every other flag and key below was verified against the CLIs installed on
 * this machine (claude, codex-cli 0.144.6, kimi 0.34.0) — not from documentation.
 *
 * The orchestrator runs on a strict allowlist (its tools plus Claude's
 * read-only built-ins) so it cannot start editing code itself. Subagents get NO
 * `--allowedTools` at all: they are meant to work, and restricting them is what
 * produced the "permission-starved" workers in the old retros.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  enabledExtraMcpServers,
  type ExtraMcpServer
} from '@shared/schema/mcpServer'
import type { ExtraMcpServer as SlotExtraMcpServer } from '@shared/schema/profile'
import { MCP_SERVER_NAME } from './server'
import { LEAD_TOOL_NAMES, ORCHESTRATOR_TOOL_NAMES } from './toolsOrchestrator'

/**
 * Either a global extra (Settings) or an E6 slot extra. Writers accept both
 * so the two sources can ride the same dialect without a second code path.
 */
export type AttachableExtra = ExtraMcpServer | SlotExtraMcpServer

/**
 * E6: extra MCP servers a SLOT declares for its subagents, defence-in-depth
 * filtered — the schema already refuses the reserved name, but these writers
 * are also reachable from tests and future callers, and a `vertragus` entry
 * here would silently shadow the reporting channel.
 */
export function usableExtraMcp(
  extra: readonly SlotExtraMcpServer[] | undefined
): SlotExtraMcpServer[] {
  return (extra ?? []).filter((server) => server.name.toLowerCase() !== MCP_SERVER_NAME)
}

/** Enabled extras from global settings. Reserved `vertragus` never comes through. */
export function attachableExtraMcpServers(
  servers?: readonly ExtraMcpServer[]
): ExtraMcpServer[] {
  return enabledExtraMcpServers(servers ?? [])
}

function isGlobalExtra(server: AttachableExtra): server is ExtraMcpServer {
  return 'transport' in server
}

/**
 * Collapse Settings extras and E6 slot extras into one ExtraMcpServer list.
 * Slot extras are HTTP-only `{ name, url }`; they become `{ id: name, url }`.
 * First id wins; reserved `vertragus` is dropped.
 */
export function extrasToAttach(
  extras?: readonly AttachableExtra[]
): ExtraMcpServer[] {
  if (!extras) return []
  const out: ExtraMcpServer[] = []
  const seen = new Set<string>()
  for (const extra of extras) {
    if (isGlobalExtra(extra)) {
      for (const server of attachableExtraMcpServers([extra])) {
        if (server.id === MCP_SERVER_NAME || seen.has(server.id)) continue
        seen.add(server.id)
        out.push(server)
      }
    } else if (extra.name.toLowerCase() !== MCP_SERVER_NAME && !seen.has(extra.name)) {
      seen.add(extra.name)
      out.push({
        transport: 'http',
        id: extra.name,
        label: extra.name,
        enabled: true,
        url: extra.url
      })
    }
  }
  return out
}

function extraStdioEntry(
  server: Extract<ExtraMcpServer, { transport: 'stdio' }>,
  withType: boolean
): Record<string, unknown> {
  const entry: Record<string, unknown> = { command: server.command }
  if (withType) entry.type = 'stdio'
  if (server.args.length > 0) entry.args = server.args
  if (server.env && Object.keys(server.env).length > 0) entry.env = server.env
  return entry
}

function extraHttpEntry(
  server: Extract<ExtraMcpServer, { transport: 'http' }>,
  withType: boolean
): Record<string, unknown> {
  const entry: Record<string, unknown> = { url: server.url }
  if (withType) entry.type = 'http'
  if (server.headers && Object.keys(server.headers).length > 0) {
    entry.headers = server.headers
  }
  return entry
}

function dialectEntry(
  extra: ExtraMcpServer,
  dialect: 'claude' | 'kimi' | 'cursor'
): Record<string, unknown> {
  const withType = dialect === 'claude'
  return extra.transport === 'stdio'
    ? extraStdioEntry(extra, withType)
    : extraHttpEntry(extra, withType)
}

/** Claude built-ins the orchestrator may use for verification without a prompt. */
export const READONLY_CLAUDE_TOOLS = ['Read', 'Glob', 'Grep', 'TodoWrite'] as const

/**
 * Worktree-relative files the project-file dialects (Kimi, Cursor, Grok)
 * write into an agent's checkout — each carries the agent's tokenised MCP
 * URL. `createWorktree` puts them on the repository's shared
 * `.git/info/exclude`, because an agent running `git add -A` in its own
 * worktree must not be able to commit its token into the user's history.
 * (Claude's config lives outside the repo; Codex passes argv overrides.)
 */
export const WORKTREE_SECRET_FILES = [
  '.cursor/mcp.json',
  '.kimi-code/mcp.json',
  '.grok/config.toml'
] as const

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

/** The orchestrator's complete allowlist: its tools plus read-only built-ins. */
export function orchestratorAllowedTools(): string[] {
  return [...orchestratorMcpTools(), ...READONLY_CLAUDE_TOOLS]
}

/** F: a lead's tools ON THIS SERVER — the scoped down-set plus the upward three. */
export function leadMcpTools(): string[] {
  return LEAD_TOOL_NAMES.map(qualifiedToolName)
}

/** F: a lead's complete allowlist — like the orchestrator, verification is read-only. */
export function leadAllowedTools(): string[] {
  return [...leadMcpTools(), ...READONLY_CLAUDE_TOOLS]
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
  /**
   * The CLI's raised per-tool-call timeout in seconds
   * (`ProviderConfig.mcpToolTimeoutSec`). Absent = the CLI's own 60 s default,
   * which is what forces `await_events` into a 50 s metronome.
   */
  toolTimeoutSec?: number
  /** Extra MCP servers (Settings extras and, for subagents, E6 slot extras). */
  extraMcpServers?: readonly AttachableExtra[]
}

/**
 * Claude Code's MCP timeout pair, both in MILLISECONDS.
 *
 * `MCP_TIMEOUT` covers server startup, `MCP_TOOL_TIMEOUT` one tool call; a long
 * `await_events` needs the latter, and raising only one of them is the kind of
 * half-measure that shows up as a 60 s failure nobody can place. Environment,
 * not settings file: the raise then belongs to this launch alone and cannot
 * leak into the user's own Claude sessions.
 */
export const CLAUDE_MCP_TIMEOUT_ENV = 'MCP_TIMEOUT'
export const CLAUDE_MCP_TOOL_TIMEOUT_ENV = 'MCP_TOOL_TIMEOUT'

/** The env pair for one Claude launch, or nothing when the provider is silent. */
export function claudeMcpTimeoutEnv(
  toolTimeoutSec: number | undefined
): Record<string, string> | undefined {
  if (!toolTimeoutSec || toolTimeoutSec <= 0) return undefined
  const ms = String(Math.floor(toolTimeoutSec) * 1000)
  return { [CLAUDE_MCP_TIMEOUT_ENV]: ms, [CLAUDE_MCP_TOOL_TIMEOUT_ENV]: ms }
}

/**
 * The `{ mcpServers: { vertragus: … } }` object Claude expects. Extra servers
 * (Settings extras and E6 slot extras) land in the SAME transient file —
 * `--strict-mcp-config` limits Claude to this file, so this is the only place
 * they can come from.
 */

export function toClaudeMcpConfig(
  url: string,
  extras?: readonly AttachableExtra[]
): { mcpServers: Record<string, unknown> } {
  const servers: Record<string, unknown> = { [MCP_SERVER_NAME]: { type: 'http', url } }
  for (const extra of extrasToAttach(extras)) {
    if (extra.id === MCP_SERVER_NAME) continue
    servers[extra.id] = dialectEntry(extra, 'claude')
  }
  return { mcpServers: servers }
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
  fileTag: string,
  extras?: readonly AttachableExtra[]
): string {
  const dir = join(configDir, 'vertragus-mcp')
  mkdirSync(dir, { recursive: true })
  const configPath = join(dir, `${fileTag}.json`)
  writeFileSync(configPath, JSON.stringify(toClaudeMcpConfig(url, extras), null, 2))
  assertWrittenClaudeMcpConfig(configPath)
  return configPath
}

/**
 * Claude Code launch arguments: transient MCP config, `--strict-mcp-config`
 * (file-scoped: extras live in that same JSON, so they are allowed), optional
 * system prompt, optional allowlist.
 */
export function buildClaudeMcpArgs(target: McpAttachTarget): string[] {
  const configPath = writeClaudeMcpConfigFile(
    target.url,
    target.configDir,
    target.fileTag,
    target.extraMcpServers
  )
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
  return buildClaudeMcpArgs({
    ...target,
    extraMcpServers: undefined,
    allowedTools: orchestratorAllowedTools()
  })
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
 *
 * Extra servers (when passed) are prepended via
 * {@link codexExtraServerOverrides} and never get `required`.
 *
 * `tool_timeout_sec` is emitted ONLY when the provider declares
 * `mcpToolTimeoutSec` — the key exists on newer Codex builds, and no shipped
 * preset claims it, because an older codex meeting an unknown key under
 * `mcp_servers.*` could refuse the launch outright (see the codex preset).
 */
export function codexServerOverrides(
  url: string,
  allowedTools?: readonly string[],
  toolTimeoutSec?: number
): string[] {
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
  if (toolTimeoutSec && toolTimeoutSec > 0) {
    args.push(CODEX_CONFIG_FLAG, `${key}.tool_timeout_sec=${Math.floor(toolTimeoutSec)}`)
  }
  return args
}

/**
 * Process-local `-c` overrides for extra MCP servers (Settings extras and E6
 * slot extras). Never `required=true` (a down extra must not block spawn) and
 * never `enabled_tools` (that key belongs only to the Vertragus server).
 *
 * KNOWN LIMIT: Codex HTTP header key is not verified in this repo — URL only.
 */
export function codexExtraServerOverrides(
  extras?: readonly AttachableExtra[]
): string[] {
  const args: string[] = []
  for (const extra of extrasToAttach(extras)) {
    if (extra.id === MCP_SERVER_NAME) continue
    const key = `mcp_servers.${extra.id}`
    if (extra.transport === 'stdio') {
      args.push(CODEX_CONFIG_FLAG, `${key}.command=${tomlString(extra.command)}`)
      if (extra.args.length > 0) {
        args.push(CODEX_CONFIG_FLAG, `${key}.args=${JSON.stringify(extra.args)}`)
      }
      if (extra.env) {
        for (const [name, value] of Object.entries(extra.env)) {
          args.push(CODEX_CONFIG_FLAG, `${key}.env.${name}=${tomlString(value)}`)
        }
      }
    } else {
      args.push(CODEX_CONFIG_FLAG, `${key}.url=${tomlString(extra.url)}`)
    }
  }
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
  return [
    ...codexServerOverrides(target.url, target.allowedTools, target.toolTimeoutSec),
    ...codexExtraServerOverrides(target.extraMcpServers)
  ]
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
    ...buildCodexMcpArgs({
      ...target,
      extraMcpServers: undefined,
      allowedTools: orchestratorMcpTools()
    }),
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
  allowedTools?: readonly string[],
  extras?: readonly AttachableExtra[]
): { mcpServers: Record<string, unknown> } {
  const entry: Record<string, unknown> = { url }
  const tools = serverScopedTools(allowedTools)
  if (tools) entry.enabledTools = tools
  const servers: Record<string, unknown> = { [MCP_SERVER_NAME]: entry }
  for (const extra of extrasToAttach(extras)) {
    if (extra.id === MCP_SERVER_NAME) continue
    servers[extra.id] = dialectEntry(extra, 'kimi')
  }
  return { mcpServers: servers }
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
  allowedTools?: readonly string[],
  extras?: readonly AttachableExtra[]
): string {
  const dir = join(workspaceDir, KIMI_PROJECT_DIR)
  mkdirSync(dir, { recursive: true })
  const configPath = join(dir, KIMI_MCP_FILE)
  writeFileSync(configPath, JSON.stringify(toKimiMcpConfig(url, allowedTools, extras), null, 2))
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
  writeKimiProjectMcpConfig(
    target.url,
    target.workspaceDir,
    target.allowedTools,
    target.extraMcpServers
  )
  const prompt = target.systemPrompt?.trim()
  if (!prompt) return []
  return [KIMI_AGENT_FILE_FLAG, writeKimiAgentFile(prompt, target.configDir, target.fileTag)]
}

/** Kimi args for an orchestrator: server-scoped allowlist + agent file. */
export function buildKimiOrchestratorArgs(
  target: Omit<McpAttachTarget, 'allowedTools'> & { workspaceDir: string }
): string[] {
  return buildKimiMcpArgs({
    ...target,
    extraMcpServers: undefined,
    allowedTools: orchestratorMcpTools()
  })
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

// --- Cursor Agent --------------------------------------------------------

/**
 * Cursor Agent has NO MCP config-file flag. Verified against cursor-agent
 * 2026.08.11: `cursor-agent mcp --help` lists login/list/list-tools/enable/
 * disable — no `add`, and no global flag that passes a server JSON. The CLI's
 * own `mcp login` help names the two locations: project
 * `<cwd>/.cursor/mcp.json` or global `~/.cursor/mcp.json`. Attachment is
 * therefore a file in the AGENT'S WORKING DIRECTORY, like Kimi — with the
 * deliberate difference that `.cursor/mcp.json` is the user's own file and
 * must be merged, not overwritten.
 */
export const CURSOR_PROJECT_DIR = '.cursor'
export const CURSOR_MCP_FILE = 'mcp.json'

/**
 * Pre-approves every server listed in the project's mcp.json for this launch.
 *
 * KNOWN LIMIT: there is no verified per-server approval flag. `--approve-mcps`
 * also approves the user's own project servers for that run. For yolo
 * subagents (already on `--force`/`--yolo`) that stays inside the same trust
 * envelope; documented rather than papered over. Approval is per-URL hashed,
 * so a stored entry never covers the next Vertragus agent's personal token —
 * the flag is required on every spawn.
 */
export const CURSOR_APPROVE_MCPS_FLAG = '--approve-mcps'

/**
 * Merge `mcpServers.vertragus = { url }` into an existing Cursor project file.
 *
 * A bare `url` means Streamable HTTP (verified). Unlike Claude's transient
 * file this MUST preserve every foreign `mcpServers` entry — the file belongs
 * to the user. Unparseable / non-object `existing` is treated as empty
 * (caller replaces a corrupt file rather than guessing).
 */
export function toCursorMcpConfig(
  existing: Record<string, unknown> | null | undefined,
  url: string,
  extras?: readonly AttachableExtra[]
): { mcpServers: Record<string, unknown> } {
  const prevServers = existing?.mcpServers
  const servers =
    prevServers && typeof prevServers === 'object' && !Array.isArray(prevServers)
      ? { ...(prevServers as Record<string, unknown>) }
      : {}
  for (const extra of extrasToAttach(extras)) {
    if (extra.id === MCP_SERVER_NAME) continue
    servers[extra.id] = dialectEntry(extra, 'cursor')
  }
  // Vertragus last so extras cannot clobber it.
  servers[MCP_SERVER_NAME] = { url }
  // Keep any other top-level keys the user already had (Cursor may grow them).
  const base =
    existing && typeof existing === 'object' && !Array.isArray(existing) ? { ...existing } : {}
  return { ...base, mcpServers: servers }
}

/** Fail closed: prove the project file we just wrote names our server. */
export function assertWrittenCursorMcpConfig(configPath: string): void {
  const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
  const servers = parsed.mcpServers as Record<string, { url?: string }> | undefined
  if (!servers || typeof servers !== 'object' || !servers[MCP_SERVER_NAME]?.url) {
    throw new Error(`Invalid Vertragus Cursor MCP config written to ${configPath}`)
  }
}

/**
 * Install / merge `<workspaceDir>/.cursor/mcp.json`.
 *
 * Reads the existing file when present; an absent or corrupt file is replaced
 * outright (fail-closed — no `.bak`, no salvage of garbage). Only the
 * `vertragus` key under `mcpServers` is set; every foreign server entry is
 * preserved.
 *
 * Two Cursor agents sharing ONE working directory therefore share one file:
 * the second install overwrites the first agent's personal URL (same clause
 * as Kimi above). Sequential starts are safe if Cursor reads the file at boot
 * (verified indirectly: each CLI run re-read it); parallel Cursor subagents
 * want `worktree: true`. Assumption: a live TUI mid-session is not re-reading
 * — if it does, the fix is worktrees, not this writer.
 *
 * The `vertragus` entry is left behind on purpose (see the module note in
 * `agents/spawn`: nothing is deleted afterwards). Cost: the user's own Cursor
 * sessions in that repo see a dead server ("needs approval"). Cleanup belongs
 * in `unregisterWorkspace` if it ever annoys — not in v1.
 */
export function writeCursorProjectMcpConfig(
  url: string,
  workspaceDir: string,
  extras?: readonly AttachableExtra[]
): string {
  const dir = join(workspaceDir, CURSOR_PROJECT_DIR)
  mkdirSync(dir, { recursive: true })
  const configPath = join(dir, CURSOR_MCP_FILE)

  let existing: Record<string, unknown> | null = null
  try {
    const raw = readFileSync(configPath, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>
    }
    // Non-object JSON (array/string/…) → treat as corrupt, replace.
  } catch {
    // Absent file or unparseable JSON → replace / create.
  }

  writeFileSync(configPath, JSON.stringify(toCursorMcpConfig(existing, url, extras), null, 2))
  assertWrittenCursorMcpConfig(configPath)
  return configPath
}

// --- Grok Build ----------------------------------------------------------

/**
 * Grok Build has no MCP config-file flag. Official docs: servers live in
 * `~/.grok/config.toml` or project `.grok/config.toml` as `[mcp_servers.<name>]`
 * with a bare `url` for HTTP. Project files only contribute mcp_servers /
 * plugins / permission, and a project table of the same name replaces the
 * user one. Attachment is therefore a file in the AGENT'S WORKING DIRECTORY,
 * like Kimi and Cursor — merged, not overwritten, because `.grok/config.toml`
 * may already hold the user's own servers.
 *
 * `--tools` / `--disallowed-tools` are headless-only (ignored in the TUI), so
 * the orchestrator cage lives in `[permission]` plus process env / argv.
 */
export const GROK_PROJECT_DIR = '.grok'
export const GROK_CONFIG_FILE = 'config.toml'
export const GROK_AGENT_DIR = 'agents'
export const GROK_AGENT_NAME = 'vertragus-orchestrator'
export const GROK_AGENT_FILE = `${GROK_AGENT_NAME}.md`
export const GROK_NO_SUBAGENTS_FLAG = '--no-subagents'
export const GROK_AGENT_FLAG = '--agent'

/**
 * Auto-approve every tool on the Vertragus MCP server for this launch.
 *
 * Grok's permission surface is `--allow` / `--deny` with `MCPTool(server__*)`
 * patterns (https://docs.x.ai/build/features/permissions). There is no
 * `--approve-mcps` and no per-server `enabled_tools` on the TOML table, so this
 * is the only launch-scoped way to keep `report_done` / `start_agent` off the
 * TUI prompt. Subagent `--always-approve` (yolo) covers the rest; the
 * orchestrator never gets yolo.
 *
 * KNOWN LIMIT: `--allow MCPTool(vertragus__*)` also covers every tool our
 * server exposes, which is the point — the allowlist is the URL (orchestrator
 * vs subagent endpoints), not a second filter here.
 */
export const GROK_ALLOW_MCP_FLAG = '--allow'

/** `MCPTool(vertragus__*)` — Grok's documented MCP permission glob. */
export function grokAllowMcpRule(serverName?: string): string {
  return `MCPTool(${serverName ?? MCP_SERVER_NAME}__*)`
}

export function grokAllowMcpArgs(): string[] {
  return [GROK_ALLOW_MCP_FLAG, grokAllowMcpRule()]
}

/**
 * Permission deny list for a Grok orchestrator. `Edit`/`Write`/`Bash` are the
 * native permission tool names (user-guide 22); unrecognized names such as
 * `Agent` are skipped with a warning, so native spawn is not killed here.
 */
export const GROK_ORCHESTRATOR_DENY = ['Edit', 'Write', 'Bash'] as const

/**
 * Permission allow list for a Grok orchestrator. MCP tools are NOT
 * auto-approved; without `MCPTool(vertragus__*)`, `start_agent` sits on a TUI
 * permission prompt. Read/Grep are the verification built-ins.
 *
 * Literal, not `grokAllowMcpRule()`: that helper reads `MCP_SERVER_NAME` from
 * server.ts, and a CJS electron-vite bundle can still be in that binding's TDZ
 * at this module's init (panel-smoke crash). Keep in sync with MCP_SERVER_NAME.
 */
export const GROK_ORCHESTRATOR_ALLOW = ['MCPTool(vertragus__*)', 'Read', 'Grep'] as const

/** Argv cage matching {@link GROK_ORCHESTRATOR_DENY} / {@link GROK_ORCHESTRATOR_ALLOW}. */
export function grokOrchestratorArgv(): string[] {
  return [
    GROK_NO_SUBAGENTS_FLAG,
    GROK_AGENT_FLAG,
    GROK_AGENT_NAME,
    ...GROK_ORCHESTRATOR_DENY.flatMap((rule) => ['--deny', rule]),
    ...GROK_ORCHESTRATOR_ALLOW.flatMap((rule) => ['--allow', rule])
  ]
}

/**
 * Env cage: disable Grok-native subagents and background workflows (the
 * `workflow` tool can spawn writers that never open a Vertragus window) and
 * select the project agent. Subagent launches must not get this.
 */
export function grokOrchestratorEnv(): Record<string, string> {
  return { GROK_SUBAGENTS: '0', GROK_WORKFLOWS: '0', GROK_AGENT: GROK_AGENT_NAME }
}

/**
 * One `[mcp_servers.<name>]` table. `url` is a TOML basic string so query
 * tokens with `=` / `&` survive; Grok treats a bare url as HTTP/SSE.
 */
export function grokMcpServerBlock(url: string, serverName = MCP_SERVER_NAME): string {
  return [`[mcp_servers.${serverName}]`, `url = ${tomlString(url)}`, ''].join('\n')
}

function grokStdioBlock(server: Extract<ExtraMcpServer, { transport: 'stdio' }>): string {
  const lines = [`[mcp_servers.${server.id}]`, `command = ${tomlString(server.command)}`]
  if (server.args.length > 0) lines.push(`args = ${JSON.stringify(server.args)}`)
  lines.push('')
  return lines.join('\n')
}

/** Replace-or-append one named table; extra servers reuse it. */
function upsertGrokBlock(existing: string, serverName: string, block: string): string {
  const escaped = serverName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const source = `^\\[mcp_servers\\.(?:"${escaped}"|${escaped})\\][ \\t]*\\r?\\n(?:(?!\\[)[^\\n]*\\r?\\n?)*`
  // Presence is checked separately: "replace produced the same string" also
  // happens when the table already carries exactly this url, and reading that
  // as "no table" would append a duplicate on every re-merge.
  if (new RegExp(source, 'm').test(existing)) {
    return existing.replace(new RegExp(source, 'gm'), () => block)
  }
  const trimmed = existing.replace(/(?:\r?\n)*$/u, '')
  return trimmed.length > 0 ? `${trimmed}\n\n${block}` : block
}

function upsertGrokTable(existing: string, serverName: string, url: string): string {
  return upsertGrokBlock(existing, serverName, grokMcpServerBlock(url, serverName))
}

interface TomlSection {
  header: string | null
  text: string
}

/** Split a TOML document into preamble + tables. Not a full parser. */
export function splitTomlSections(raw: string): TomlSection[] {
  const lines = raw.replace(/\r\n/g, '\n').split('\n')
  const sections: { header: string | null; lines: string[] }[] = [{ header: null, lines: [] }]
  for (const line of lines) {
    const match = /^\[([^[\]]+)\]\s*$/.exec(line.trim())
    if (match) {
      sections.push({ header: match[1]!, lines: [line] })
    } else {
      sections[sections.length - 1]!.lines.push(line)
    }
  }
  return sections.map((section) => ({ header: section.header, text: section.lines.join('\n') }))
}

function joinTomlSections(sections: readonly TomlSection[]): string {
  const parts = sections
    .map((section) => section.text.replace(/\n+$/, ''))
    .filter((text) => text.trim().length > 0)
  return parts.length === 0 ? '' : `${parts.join('\n\n')}\n`
}

const TOML_IDENT = String.raw`(?:[\w-]+|"[^"]+"|'[^']+')`
const TOML_HEADER = new RegExp(
  String.raw`^\[{1,2}${TOML_IDENT}(?:\.${TOML_IDENT})*\]{1,2}(?:\s*#.*)?$`
)
const TOML_ASSIGNMENT = new RegExp(String.raw`^${TOML_IDENT}(?:\.${TOML_IDENT})*\s*=\s*(.*)$`)

function countChar(text: string, char: string): number {
  let count = 0
  for (const current of text) if (current === char) count += 1
  return count
}

/**
 * True when every significant line looks like TOML (table header, assignment,
 * or a continuation of an open array/inline-table/multiline string). Prose,
 * JSON, HTML and other garbage fail — merge would otherwise prepend them as a
 * preamble, Grok would reject the file, and both MCP attach and the permission
 * cage would disappear.
 */
function isProbablyToml(raw: string): boolean {
  const lines = raw.replace(/\r\n/g, '\n').split('\n')
  let openBrackets = 0
  let inTripleDouble = false
  let inTripleSingle = false

  for (const line of lines) {
    const trimmed = line.trim()
    if (inTripleDouble) {
      if (trimmed.includes('"""')) inTripleDouble = false
      continue
    }
    if (inTripleSingle) {
      if (trimmed.includes("'''")) inTripleSingle = false
      continue
    }
    if (!trimmed || trimmed.startsWith('#')) continue
    if (openBrackets > 0) {
      openBrackets += countChar(trimmed, '[') - countChar(trimmed, ']')
      openBrackets += countChar(trimmed, '{') - countChar(trimmed, '}')
      if (openBrackets < 0) return false
      continue
    }
    if (TOML_HEADER.test(trimmed)) continue
    const assigned = TOML_ASSIGNMENT.exec(trimmed)
    if (!assigned) return false
    const value = assigned[1] ?? ''
    if (value.startsWith('"""') && !value.slice(3).includes('"""')) inTripleDouble = true
    else if (value.startsWith("'''") && !value.slice(3).includes("'''")) inTripleSingle = true
    else {
      openBrackets += countChar(value, '[') - countChar(value, ']')
      openBrackets += countChar(value, '{') - countChar(value, '}')
      if (openBrackets < 0) return false
    }
  }
  return true
}

function formatTomlStringArray(values: readonly string[]): string {
  return `[\n${values.map((value) => `  ${tomlString(value)},`).join('\n')}\n]`
}

function parseTomlStringArray(body: string, key: string): string[] | undefined {
  const match = new RegExp(`^${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`, 'm').exec(body)
  if (!match) return undefined
  const items: string[] = []
  const itemRe = /"((?:\\.|[^"\\])*)"/g
  let item: RegExpExecArray | null
  while ((item = itemRe.exec(match[1]!))) {
    items.push(JSON.parse(`"${item[1]}"`) as string)
  }
  return items
}

function unionUnique(base: readonly string[] | undefined, extra: readonly string[]): string[] {
  const out = [...(base ?? [])]
  for (const item of extra) {
    if (!out.includes(item)) out.push(item)
  }
  return out
}

function upsertTomlArray(sectionText: string, key: string, values: readonly string[]): string {
  const formatted = `${key} = ${formatTomlStringArray(values)}`
  const re = new RegExp(`^${key}\\s*=\\s*\\[[\\s\\S]*?\\]`, 'm')
  if (re.test(sectionText)) return sectionText.replace(re, formatted)
  return `${sectionText.replace(/\n+$/, '')}\n${formatted}`
}

function permissionCageTable(existingBody?: string): string {
  const deny = unionUnique(existingBody ? parseTomlStringArray(existingBody, 'deny') : undefined, [
    ...GROK_ORCHESTRATOR_DENY
  ])
  const allow = unionUnique(existingBody ? parseTomlStringArray(existingBody, 'allow') : undefined, [
    ...GROK_ORCHESTRATOR_ALLOW
  ])
  const header = '[permission]'
  const base = existingBody?.trim() ? existingBody.replace(/\n+$/, '') : header
  return upsertTomlArray(upsertTomlArray(base, 'deny', deny), 'allow', allow)
}

function mergeGrokPermissionCage(existing: string): string {
  const sections = splitTomlSections(existing)
  const index = sections.findIndex((section) => section.header === 'permission')
  if (index >= 0) {
    sections[index] = { header: 'permission', text: permissionCageTable(sections[index]!.text) }
  } else {
    sections.push({ header: 'permission', text: permissionCageTable() })
  }
  return joinTomlSections(sections)
}

/**
 * Replace an existing `[mcp_servers.vertragus]` table, or append one — plus
 * one table per extra server the same way — and, for the orchestrator, the
 * permission cage.
 *
 * A file that is not TOML is replaced outright (fail-closed, same as Cursor's
 * corrupt-JSON path): merging prose as a preamble would make Grok reject the
 * file and drop both MCP and the cage.
 *
 * Deliberately not a full TOML parser for MCP tables: the only tables we own
 * in this file are our own. Foreign tables, `[plugins]`, and a non-orchestrator
 * `[permission]` stay byte for byte. Quoted (`[mcp_servers."vertragus"]`) and
 * bare headers both match.
 */
export function mergeGrokConfigToml(
  existing: string,
  url: string,
  extras?: readonly AttachableExtra[],
  orchestrator = false
): string {
  const base = existing.trim() && !isProbablyToml(existing) ? '' : existing
  let merged = upsertGrokTable(base, MCP_SERVER_NAME, url)
  for (const extra of extrasToAttach(extras)) {
    if (extra.id === MCP_SERVER_NAME) continue
    merged =
      extra.transport === 'http'
        ? upsertGrokTable(merged, extra.id, extra.url)
        : upsertGrokBlock(merged, extra.id, grokStdioBlock(extra))
  }
  if (orchestrator) merged = mergeGrokPermissionCage(merged)
  return merged
}

/** Fresh-file form used when there is nothing to merge. */
export function renderGrokProjectMcpConfig(url: string, orchestrator: boolean): string {
  return mergeGrokConfigToml('', url, undefined, orchestrator)
}

/** Fail closed: prove the project file we just wrote names our server URL. */
export function assertWrittenGrokMcpConfig(
  configPath: string,
  url: string,
  options: { orchestrator?: boolean } = {}
): void {
  const raw = readFileSync(configPath, 'utf8')
  const hasTable = /^\[mcp_servers\.(?:"vertragus"|vertragus)\]/m.test(raw)
  if (!hasTable || !raw.includes(tomlString(url))) {
    throw new Error(`Invalid Vertragus Grok MCP config written to ${configPath}`)
  }
  if (options.orchestrator) {
    for (const rule of GROK_ORCHESTRATOR_DENY) {
      if (!raw.includes(tomlString(rule))) {
        throw new Error(`Invalid Vertragus Grok MCP config written to ${configPath}`)
      }
    }
    if (!raw.includes(tomlString(GROK_ORCHESTRATOR_ALLOW[0]!))) {
      throw new Error(`Invalid Vertragus Grok MCP config written to ${configPath}`)
    }
  }
}

/**
 * Install / merge `<workspaceDir>/.grok/config.toml`.
 *
 * Reads the existing file when present; an absent, unreadable, or non-TOML
 * file is replaced. Only the `[mcp_servers.vertragus]` table (and, for the
 * orchestrator, the permission cage) is written; every foreign table is
 * preserved. E6 extra servers are upserted the same way.
 *
 * Two Grok agents sharing ONE working directory therefore share one file: the
 * second install overwrites the first agent's personal URL (same clause as
 * Kimi / Cursor). That cannot happen in Vertragus: every agent runs in its
 * own worktree.
 *
 * The `vertragus` table is left behind on purpose (see the module note in
 * `agents/spawn`: nothing is deleted afterwards).
 */
export function writeGrokProjectMcpConfig(
  url: string,
  workspaceDir: string,
  extras?: readonly AttachableExtra[],
  options: { orchestrator?: boolean } = {}
): string {
  const orchestrator = Boolean(options.orchestrator)
  const dir = join(workspaceDir, GROK_PROJECT_DIR)
  mkdirSync(dir, { recursive: true })
  const configPath = join(dir, GROK_CONFIG_FILE)

  let existing = ''
  try {
    existing = readFileSync(configPath, 'utf8')
  } catch {
    // Absent file → create.
  }

  writeFileSync(configPath, mergeGrokConfigToml(existing, url, extras, orchestrator))
  assertWrittenGrokMcpConfig(configPath, url, { orchestrator })
  return configPath
}

/**
 * Project agent that strips native write/shell/spawn from the Grok toolset.
 * `disallowedTools: Agent` is the TUI-safe equivalent of headless
 * `--disallowed-tools Agent`. Subagent launches must not load this file.
 */
export function grokOrchestratorAgentFileText(): string {
  return [
    '---',
    `name: ${GROK_AGENT_NAME}`,
    'description: Vertragus orchestrator — delegates via MCP start_agent; no native edit, shell, or spawn_subagent.',
    'tools: read_file, list_dir, grep, search_tool, use_tool, todo_write',
    'disallowedTools: Agent',
    '---',
    '',
    'You are the Vertragus orchestrator. Delegate with start_agent; do not edit files, run a shell, or call spawn_subagent.',
    ''
  ].join('\n')
}

/** Write `<workspaceDir>/.grok/agents/vertragus-orchestrator.md`. */
export function writeGrokOrchestratorAgentFile(workspaceDir: string): string {
  const dir = join(workspaceDir, GROK_PROJECT_DIR, GROK_AGENT_DIR)
  mkdirSync(dir, { recursive: true })
  const agentPath = join(dir, GROK_AGENT_FILE)
  writeFileSync(agentPath, grokOrchestratorAgentFileText())
  return agentPath
}

/**
 * Grok launch arguments: the MCP attachment is a file (so it contributes no
 * path flag). Subagents get `--allow MCPTool(vertragus__*)`. Orchestrators get
 * the permission cage argv and the project agent file.
 */
export function buildGrokMcpArgs(target: {
  url: string
  workspaceDir: string
  orchestrator?: boolean
  extraMcpServers?: readonly AttachableExtra[]
}): string[] {
  writeGrokProjectMcpConfig(target.url, target.workspaceDir, target.extraMcpServers, {
    orchestrator: Boolean(target.orchestrator)
  })
  if (!target.orchestrator) return grokAllowMcpArgs()
  writeGrokOrchestratorAgentFile(target.workspaceDir)
  return grokOrchestratorArgv()
}

/** Grok args for an orchestrator: permission cage + agent file. */
export function buildGrokOrchestratorArgs(target: {
  url: string
  workspaceDir: string
  extraMcpServers?: readonly AttachableExtra[]
}): string[] {
  return buildGrokMcpArgs({ ...target, extraMcpServers: undefined, orchestrator: true })
}

/** Grok args for a subagent: attached, uncaged, MCP tools pre-allowed. */
export function buildGrokSubagentArgs(target: {
  url: string
  workspaceDir: string
  extraMcpServers?: readonly AttachableExtra[]
}): string[] {
  return buildGrokMcpArgs({ ...target, orchestrator: false })
}
