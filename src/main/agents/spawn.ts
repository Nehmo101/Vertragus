/**
 * The spawn pipeline: a {@link ProviderConfig} plus one agent's context becomes
 * a real PTY process. This is the single place a provider CLI is ever started.
 *
 * Three rules are encoded here, each of them a bug from the previous
 * generation:
 *
 * 1. **Every spawn makes an MCP decision.** The attach args come from
 *    `provider.mcp`, and `none` is a declared value, never an omission. The old
 *    repo had a second, interactive spawn path that forgot the config and
 *    produced subagents with no way to report back.
 * 2. **The orchestrator never gets yolo args.** Not "unless configured" — the
 *    yolo flags are only appended for `kind: 'subagent'`, so no profile, no
 *    master switch and no custom provider can hand `--dangerously-skip-*` to
 *    the agent that is supposed to only delegate.
 * 3. **Never `pty.spawn('cmd')` naked.** Everything goes through
 *    {@link resolveLaunch}: on Windows the CLIs are `.cmd`/`.ps1` shims that a
 *    PTY cannot exec. And when an argument carries a newline — a system prompt
 *    does — the cmd.exe wrapper would truncate it at the first line, so those
 *    launches demand an argument-faithful entrypoint.
 *
 * `buildAgentArgv` is the pure, snapshot-testable core; `buildAgentLaunch` adds
 * command resolution; `spawnAgent` adds the process.
 *
 * **What a launch leaves on disk.** Nothing is deleted afterwards, on purpose:
 * a CLI re-reads these files whenever it restarts, and removing them under a
 * live agent is worse than a stray file.
 *
 * - `<configDir>/vertragus-mcp/<fileTag>.json` — Claude's transient MCP config.
 * - `<configDir>/vertragus-mcp/<fileTag>.agent.md` — Kimi's agent profile.
 *   `configDir` is Electron's `userData`, so both live outside the repository.
 * - `<cwd>/.kimi-code/mcp.json` — Kimi's MCP attachment. This one is IN THE
 *   AGENT'S WORKING DIRECTORY (its own worktree) because that is the only
 *   place Kimi looks. It is the single artefact a Vertragus launch writes into
 *   user territory.
 * - Codex writes nothing at all: every setting is a process-local `-c` override.
 */
import {
  buildCodexMcpArgs,
  codexDeveloperInstructionsArgs,
  orchestratorAllowedTools,
  orchestratorMcpTools,
  writeClaudeMcpConfigFile,
  writeKimiAgentFile,
  writeKimiProjectMcpConfig
} from '@main/mcp/attach'
import {
  buildEffortArgs,
  buildModelArgs,
  type EffortLevel,
  type ProviderConfig
} from '@shared/schema/provider'
import { ensureClaudeWorkspaceTrust } from './claudeTrust'
import { PtyAgent, type PtyAgentLike, type PtySpawnOptions } from './PtyAgent'
import { resolveLaunch, type ResolveLaunchOptions } from './resolveCommand'

/** Orchestrator and subagent differ in exactly two places: yolo and allowlist. */
export type AgentLaunchKind = 'orchestrator' | 'subagent'

/**
 * The PTY surface the workspace layer needs. Wider than {@link PtyAgentLike}
 * (which is what the IPC layer sees) because the workspace also spawns, reads a
 * tail for `read_output` and pushes spawn errors into the scrollback.
 */
export interface AgentPty extends PtyAgentLike {
  spawn(options: PtySpawnOptions): void
  tail(chars: number): string
  push(data: string): void
  dispose(): void
}

export interface AgentLaunchInput {
  kind: AgentLaunchKind
  provider: ProviderConfig
  /** Model id; empty/absent leaves the CLI on its own default. */
  model?: string
  effort?: EffortLevel
  /** Honored for subagents only — see rule 2 above. */
  yolo?: boolean
  /** Working directory: this agent's own worktree. */
  cwd: string
  /** This agent's personal MCP URL, already carrying ws/agent/token. */
  mcpUrl: string
  /** Unique per agent — names the transient MCP config file. */
  fileTag: string
  /** Directory the transient MCP config files are written into. */
  configDir: string
  /** Role prompt for a subagent, orchestrator prompt for the orchestrator. */
  systemPrompt?: string
  /** Platform override for testing the Windows resolution off-Windows. */
  platform?: NodeJS.Platform
}

export interface AgentArgv {
  /** The composed argument vector, before PATH/shim resolution. */
  argv: string[]
  /**
   * Set when the provider takes its system prompt through the terminal
   * (`systemPromptDelivery: 'pty'`, e.g. Cursor and Ollama). The caller must
   * type this before the first task — there is no launch flag for it.
   */
  ptySystemPrompt?: string
}

export interface ResolvedLaunch extends AgentArgv {
  /** Executable actually handed to node-pty (post shim resolution). */
  file: string
  /** Arguments actually handed to node-pty. */
  args: string[]
  /** The provider's declared command, before resolution — for logs and errors. */
  command: string
  cwd: string
}

/**
 * MCP attach arguments for one agent.
 *
 * The flags come from the provider descriptor, not from hard-coded strings, so
 * an edited preset or a custom Claude-compatible CLI keeps working. The config
 * file itself and the orchestrator allowlist come from `mcp/attach` — that
 * module owns "what does a valid attachment look like", this one owns "which
 * flags does this provider spell it with". For the shipped claude preset both
 * routes produce byte-identical args; a test pins that equivalence.
 */
export function buildMcpArgs(input: AgentLaunchInput): string[] {
  const { provider } = input
  switch (provider.mcp.kind) {
    case 'claude-json': {
      const configPath = writeClaudeMcpConfigFile(input.mcpUrl, input.configDir, input.fileTag)
      const args = [provider.mcp.configArg, configPath]
      if (provider.mcp.strictArg) args.push(provider.mcp.strictArg)
      // Subagents run WITHOUT an allowlist on purpose: a worker must be able to
      // edit, run and commit. Its discipline comes from the task contract, not
      // from a tool cage — the cage is what starved the old repo's workers.
      if (input.kind === 'orchestrator' && provider.mcp.allowedToolsArg) {
        args.push(provider.mcp.allowedToolsArg, orchestratorAllowedTools().join(','))
      }
      return args
    }
    case 'codex-overrides':
      // Codex takes no config file: the whole attachment is `-c` overrides.
      // The orchestrator's allowlist is SERVER-scoped here (`enabled_tools`),
      // so Claude's read-only built-ins have no place in it.
      return buildCodexMcpArgs({
        url: input.mcpUrl,
        configDir: input.configDir,
        fileTag: input.fileTag,
        ...(input.kind === 'orchestrator' ? { allowedTools: orchestratorMcpTools() } : {})
      })
    case 'kimi-project':
      // Kimi has no flag either — the attachment is a file in the agent's own
      // working directory, so this contributes nothing to the argv. It is
      // still a spawn-time decision: no file, no reachable orchestrator.
      writeKimiProjectMcpConfig(
        input.mcpUrl,
        input.cwd,
        input.kind === 'orchestrator' ? orchestratorMcpTools() : undefined
      )
      return []
    case 'none':
      return []
  }
}

/**
 * How the system prompt reaches this provider. Exactly one place emits it —
 * either as launch args or as text for the seed handshake — so a prompt can
 * never arrive twice or not at all.
 */
export function buildSystemPromptArgs(input: AgentLaunchInput): AgentArgv {
  const prompt = input.systemPrompt?.trim()
  if (!prompt) return { argv: [] }
  const delivery = input.provider.systemPromptDelivery
  switch (delivery.kind) {
    case 'arg':
      return { argv: [delivery.flag, prompt] }
    case 'pty':
      return { argv: [], ptySystemPrompt: prompt }
    case 'agent-file':
      // Kimi: a markdown agent profile whose body REPLACES the default system
      // prompt. The flag comes from the descriptor, the file format from
      // `mcp/attach` — Kimi's parser rejects a profile without kebab-case
      // frontmatter, so it is not a place for an ad-hoc write.
      return { argv: [delivery.flag, writeKimiAgentFile(prompt, input.configDir, input.fileTag)] }
    case 'codex-config':
      // Codex has no system-prompt flag; the prompt is a process-local config
      // override like everything else it takes.
      return { argv: codexDeveloperInstructionsArgs(prompt) }
  }
}

/**
 * The pure core: provider descriptor + context → argument vector.
 *
 * Order matters. `provider.args` first (`ollama run`), then the model — which
 * for a provider without `modelArg` is positional and must sit directly behind
 * those args — then effort, yolo, MCP attach and the system prompt.
 */
export function buildAgentArgv(input: AgentLaunchInput): AgentArgv {
  const { provider } = input
  const argv = [...provider.args]
  argv.push(...buildModelArgs(provider, input.model))
  argv.push(...buildEffortArgs(provider, input.effort))
  if (input.kind === 'subagent' && input.yolo) argv.push(...provider.yoloArgs)
  argv.push(...buildMcpArgs(input))
  const prompt = buildSystemPromptArgs(input)
  argv.push(...prompt.argv)
  return { argv, ptySystemPrompt: prompt.ptySystemPrompt }
}

export interface LaunchDeps {
  resolve?: (
    command: string,
    args: string[],
    options?: ResolveLaunchOptions
  ) => Promise<{ file: string; args: string[] }>
}

/** True when any argument would be mangled by a cmd.exe/PowerShell wrapper. */
export function needsFaithfulArgs(argv: readonly string[]): boolean {
  return argv.some((arg) => /[\r\n]/.test(arg))
}

/**
 * Compose the argv and resolve the executable. Everything a launch needs, with
 * no process started yet — which is what makes the whole pipeline testable.
 */
export async function buildAgentLaunch(
  input: AgentLaunchInput,
  deps: LaunchDeps = {}
): Promise<ResolvedLaunch> {
  const { argv, ptySystemPrompt } = buildAgentArgv(input)
  const resolve = deps.resolve ?? resolveLaunch
  const resolved = await resolve(input.provider.command, argv, {
    requireFaithfulArgs: needsFaithfulArgs(argv),
    ...(input.platform ? { platform: input.platform } : {})
  })
  return {
    file: resolved.file,
    args: resolved.args,
    command: input.provider.command,
    argv,
    cwd: input.cwd,
    ptySystemPrompt
  }
}

export interface SpawnAgentDeps extends LaunchDeps {
  /** Injectable PTY construction — the workspace tests never touch a process. */
  createPty?: () => AgentPty
  cols?: number
  rows?: number
  /** Injectable trust pre-acceptance; see {@link ensureClaudeWorkspaceTrust}. */
  ensureTrust?: (workspaceDir: string) => void
}

/**
 * True for the CLIs that gate a new directory behind an interactive trust
 * prompt. Keyed on `presetId`, not on the command name: only the shipped preset
 * is known to store its answer in `~/.claude.json`, and writing that file for a
 * custom CLI that merely happens to be called `claude` would be a guess.
 */
export function needsTrustPreacceptance(provider: ProviderConfig): boolean {
  return provider.presetId === 'claude'
}

export interface SpawnedAgent {
  pty: AgentPty
  launch: ResolvedLaunch
}

/**
 * Build the launch and start the process.
 *
 * A spawn failure is not thrown away: the error is written into the agent's own
 * scrollback so it shows up in the CLI window and in `read_output`, exactly
 * where someone debugging a dead agent looks first — and then rethrown so the
 * caller (and through it `start_agent`) reports a real failure.
 *
 * Directly before the process starts, the working directory is pre-trusted for
 * the CLIs that would otherwise open a modal trust prompt. It happens here, in
 * the one place a CLI is ever launched, so orchestrator, subagent and worktree
 * paths are covered by construction. It is best-effort: a failure only means
 * the user sees the dialog once, so it never blocks a launch.
 */
export async function spawnAgent(
  input: AgentLaunchInput,
  deps: SpawnAgentDeps = {}
): Promise<SpawnedAgent> {
  const launch = await buildAgentLaunch(input, deps)
  if (needsTrustPreacceptance(input.provider)) {
    const ensureTrust =
      deps.ensureTrust ??
      ((dir: string): void => {
        ensureClaudeWorkspaceTrust(dir)
      })
    try {
      ensureTrust(launch.cwd)
    } catch (error) {
      console.warn('[spawn] trust pre-acceptance failed — the CLI may ask:', error)
    }
  }
  const pty = deps.createPty ? deps.createPty() : new PtyAgent()
  try {
    pty.spawn({
      file: launch.file,
      args: launch.args,
      cwd: launch.cwd,
      ...(deps.cols ? { cols: deps.cols } : {}),
      ...(deps.rows ? { rows: deps.rows } : {})
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    pty.push(`\x1b[31mVertragus: spawn of "${launch.command}" failed: ${message}\x1b[0m\r\n`)
    throw error
  }
  return { pty, launch }
}
