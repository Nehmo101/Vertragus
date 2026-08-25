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
 *   AGENT'S WORKING DIRECTORY (its own worktree — the orchestrator included)
 *   because that is the only place Kimi looks.
 * - `<cwd>/.cursor/mcp.json` — Cursor's MCP attachment (merged, not overwritten).
 *   Same working-directory rule as Kimi; the `vertragus` entry is left behind
 *   on purpose so a live CLI cannot lose its server mid-session.
 * - `<cwd>/.cursor/cli.json` — Cursor yolo subagents only. Sets
 *   `approvalMode: unrestricted` and `sandbox.mode: disabled` (Run Everything)
 *   so a persisted Auto-review default cannot override `--force`.
 * - `<cwd>/.grok/config.toml` — Grok Build's MCP attachment (merged). Same
 *   working-directory rule; only the `[mcp_servers.vertragus]` table is ours.
 *   Orchestrator writes `[permission]` deny/allow as well; subagent is URL-only.
 * - `<cwd>/.grok/agents/vertragus-orchestrator.md` — Grok orchestrator agent
 *   (tool allowlist + `disallowedTools: Agent`). Subagents do not get this file
 *   as their session agent.
 * - `<cwd>/.pi/mcp.json` — Pi harness wrap MCP attachment (merged). Written
 *   INSTEAD of the native dialect files when the wrap is on. The slot's
 *   provider (Claude / Cursor / …) stays; only the process is the lockfile
 *   `pi` CLI (Electron as Node, or PATH `pi` if the package is missing).
 * - `<cwd>/.pi/APPEND_SYSTEM.md` — Pi wrap role / orchestrator prompt. No
 *   token; `--append-system-prompt` gets the absolute path so argv stays
 *   one-line. Removed when the launch has no prompt, so a stale file cannot
 *   be auto-discovered after `--approve`.
 * - `<configDir>/vertragus-mcp/pi-cli-entry.cjs` — Electron-as-node only.
 *   The *script* argv (not a Node `-r` in front of `dist/cli.js`: Pi's
 *   `-r` is `--resume`). Polyfills stdin/stdout/stderr `.isTTY` then
 *   imports the lockfile CLI; without it Pi picks print mode and
 *   `process.exit(1)` on the first goal when it has no provider key.
 *
 *   These project-file dialects are the only artefacts a Vertragus launch writes
 *   into user territory. Since every agent owns its worktree they can no longer
 *   collide between parallel agents — which is exactly why the worktree became

 *   mandatory rather than opt-in.
 * - Codex writes nothing at all: every setting is a process-local `-c` override.
 */
import {
  buildCodexMcpArgs,
  claudeMcpTimeoutEnv,
  CURSOR_APPROVE_MCPS_FLAG,
  grokAllowMcpArgs,
  grokOrchestratorArgv,
  grokOrchestratorEnv,
  codexDeveloperInstructionsArgs,
  leadAllowedTools,
  leadMcpTools,
  orchestratorAllowedTools,
  orchestratorMcpTools,
  writeClaudeMcpConfigFile,
  writeCursorProjectMcpConfig,
  writeGrokOrchestratorAgentFile,
  writeGrokProjectMcpConfig,
  writeKimiAgentFile,
  writeKimiProjectMcpConfig,
  writePiHarnessAppendSystemPrompt,
  writePiHarnessMcpConfig
} from '@main/mcp/attach'
import {
  buildPiHarnessArgv,
  PI_HARNESS_COMMAND,
  piHarnessEnv,
  resolvePiHarnessCli,
  writePiCliEntry
} from './piHarness'
import type { ExtraMcpServer } from '@shared/schema/mcpServer'
import type { ExtraMcpServer as SlotExtraMcpServer } from '@shared/schema/profile'
import {
  buildEffortArgs,
  buildInitialPromptArgs,
  buildModelArgs,
  type EffortLevel,
  type ProviderConfig
} from '@shared/schema/provider'
import { ensureClaudeWorkspaceTrust } from './claudeTrust'
import { ensureCursorMcpApprovals } from './cursorMcpApprovals'
import {
  applyCursorRunEverything,
  cursorUsesProjectDialect,
  ensureCursorRunEverythingConfig
} from './cursorRunMode'
import { ensureKimiWorkspaceTrust } from './kimiTrust'
import { PtyAgent, type PtyAgentLike, type PtySpawnOptions } from './PtyAgent'
import { resolveLaunch, type ResolveLaunchOptions } from './resolveCommand'

/**
 * Orchestrator and subagent differ in exactly two places: yolo and allowlist.
 * F adds 'lead': launched like an orchestrator (never yolo) but with the lead
 * allowlist — the scoped down-tools plus the upward reporting tools.
 */
export type AgentLaunchKind = 'orchestrator' | 'subagent' | 'lead'

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
  /**
   * First user turn, when the provider declares `initialPromptDelivery`.
   * Orchestrator start-goal only. Never a headless `-p` / `--single` one-shot.
   */
  initialPrompt?: string
  /**
   * E6: extra MCP servers from the agent's slot. Honored for `kind:
   * 'subagent'` ONLY — same construction as the yolo rule: no profile and no
   * caller can hand an orchestrator or lead a second tool surface.
   */
  extraMcp?: readonly SlotExtraMcpServer[]
  /**
   * Extra MCP servers from global settings. Honored for `kind: 'subagent'`
   * ONLY — same rule as {@link extraMcp}: orchestrator and lead stay on the
   * built-in Vertragus server.
   */
  extraMcpServers?: readonly ExtraMcpServer[]
  /**
   * Overlay, not a provider. `'pi'` starts the lockfile Pi CLI (Electron as
   * Node, or PATH `pi` if the package is missing) with the slot's preset
   * mapped onto `--provider` and the slot's model onto `--model`.
   * Native CLI args, yolo flags and native MCP attach are skipped. Absent =
   * current behavior (spawn `claude` / `cursor-agent` / …).
   */
  harness?: 'pi'
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
  /**
   * Extra environment variables for this process. Merged over `process.env` by
   * PtyAgent. Used by the Grok orchestrator cage (`GROK_SUBAGENTS=0`).
   */
  env?: Record<string, string>
}

export interface ResolvedLaunch extends AgentArgv {
  /** Executable actually handed to node-pty (post shim resolution). */
  file: string
  /** Arguments actually handed to node-pty. */
  args: string[]
  /** The provider's declared command, before resolution — for logs and errors. */
  command: string
  cwd: string
  /**
   * Environment overlaid on `process.env` for this launch only. Set when the
   * provider's MCP dialect spells a setting as an env var; absent otherwise —
   * see {@link buildAgentEnv}.
   */
  env?: Record<string, string>
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
  // Settings extras and E6 slot extras both reach SUBAGENTS only — an
  // orchestrator or lead with a browser tool is a delegator that starts
  // doing the work itself.
  const extras =
    input.kind === 'subagent'
      ? [...(input.extraMcpServers ?? []), ...(input.extraMcp ?? [])]
      : []
  switch (provider.mcp.kind) {
    case 'claude-json': {
      const configPath = writeClaudeMcpConfigFile(
        input.mcpUrl,
        input.configDir,
        input.fileTag,
        extras
      )
      const args = [provider.mcp.configArg, configPath]
      if (provider.mcp.strictArg) args.push(provider.mcp.strictArg)
      // Subagents run WITHOUT an allowlist on purpose: a worker must be able to
      // edit, run and commit. Its discipline comes from the task contract, not
      // from a tool cage — the cage is what starved the old repo's workers.
      if (input.kind === 'orchestrator' && provider.mcp.allowedToolsArg) {
        args.push(provider.mcp.allowedToolsArg, orchestratorAllowedTools().join(','))
      }
      if (input.kind === 'lead' && provider.mcp.allowedToolsArg) {
        args.push(provider.mcp.allowedToolsArg, leadAllowedTools().join(','))
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
        extraMcpServers: extras,
        ...(input.kind === 'orchestrator' ? { allowedTools: orchestratorMcpTools() } : {}),
        ...(input.kind === 'lead' ? { allowedTools: leadMcpTools() } : {}),
        // Codex spells the raised tool timeout as one more `-c` override; it
        // is emitted only when the provider claims the capability.
        ...(provider.mcpToolTimeoutSec ? { toolTimeoutSec: provider.mcpToolTimeoutSec } : {})
      })
    case 'kimi-project':
      // Kimi has no flag either — the attachment is a file in the agent's own
      // working directory, so this contributes nothing to the argv. It is
      // still a spawn-time decision: no file, no reachable orchestrator.
      writeKimiProjectMcpConfig(
        input.mcpUrl,
        input.cwd,
        input.kind === 'orchestrator'
          ? orchestratorMcpTools()
          : input.kind === 'lead'
            ? leadMcpTools()
            : undefined,
        extras
      )
      return []
    case 'cursor-project':
      // Cursor reads `<cwd>/.cursor/mcp.json` and has no config-file flag.
      // `--approve-mcps` is required because approval is per-URL hashed and
      // never reusable across Vertragus agents. The TUI still prompts per
      // server on many builds, so spawn also writes mcp-approvals.json
      // (see ensureCursorMcpApprovals) — flag AND state file. KNOWN LIMITS:
      // - no per-server tool filter — orchestrator scoping stays URL-side
      //   (same declared limit as Codex' missing `--strict-mcp-config`);
      // - the flag also approves the user's own project servers for this run.
      writeCursorProjectMcpConfig(input.mcpUrl, input.cwd, extras)
      return [CURSOR_APPROVE_MCPS_FLAG]
    case 'grok-project': {
      // Grok reads `<cwd>/.grok/config.toml` and has no config-file flag.
      // `--tools` / `--disallowed-tools` are headless-only (ignored in TUI).
      // Orchestrator: URL + permission deny/allow, plus `--no-subagents` /
      // `--deny` / `--allow` / `--agent` matching the TOML. Subagent/lead:
      // URL + `--allow MCPTool(vertragus__*)` so loopback tools skip the TUI
      // prompt. extras is already empty for orchestrator/lead.
      const orchestrator = input.kind === 'orchestrator'
      writeGrokProjectMcpConfig(input.mcpUrl, input.cwd, extras, { orchestrator })
      if (!orchestrator) return grokAllowMcpArgs()
      writeGrokOrchestratorAgentFile(input.cwd)
      return grokOrchestratorArgv()
    }
    case 'none':
      return []
  }
}

/**
 * Per-launch environment for one agent.
 *
 * Claude: MCP tool-call timeout, spelled as env vars. The number is the
 * provider's `mcpToolTimeoutSec` claim; the SPELLING is the dialect's, which
 * is why the pair itself lives in `mcp/attach` next to every other per-CLI
 * attachment fact. Claude reads `MCP_TIMEOUT`/`MCP_TOOL_TIMEOUT` from its
 * environment (milliseconds), so the raise dies with the process — the same
 * philosophy as Codex' `-c` overrides and the transient config file: a
 * Vertragus launch never edits a user-global config. Codex takes its raise as
 * an argument instead (`tool_timeout_sec`, see {@link buildMcpArgs}), and the
 * remaining dialects have no verified timeout mechanism.
 *
 * Every kind of Claude agent gets the timeout, not just the orchestrator:
 * `await_events` is the orchestrator's loop, but a lead runs the same loop, and
 * a subagent whose CLI survives a long tool call is never worse off.
 *
 * Grok orchestrator: `GROK_SUBAGENTS=0` / `GROK_WORKFLOWS=0` plus the project
 * agent name. Subagent and lead launches must not get this — native spawn is
 * how a Grok worker works.
 *
 * Pi wrap: when the lockfile CLI is used, `ELECTRON_RUN_AS_NODE=1` so Electron's
 * binary runs a CJS entry that polyfills TTY then imports `dist/cli.js` (see
 * {@link writePiCliEntry}). PATH fallback (no bundled CLI) adds nothing —
 * wrap-on Grok must not inherit the native cage env.
 */
export function buildAgentEnv(
  input: AgentLaunchInput,
  deps: Pick<LaunchDeps, 'resolvePiCli'> = {}
): Record<string, string> | undefined {
  if (input.harness === 'pi') {
    const cli = (deps.resolvePiCli ?? resolvePiHarnessCli)()
    return piHarnessEnv(cli)
  }
  if (input.kind === 'orchestrator' && input.provider.mcp.kind === 'grok-project') {
    return grokOrchestratorEnv()
  }
  if (input.provider.mcp.kind !== 'claude-json') return undefined
  return claudeMcpTimeoutEnv(input.provider.mcpToolTimeoutSec)
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
 * those args — then effort, yolo, MCP attach, the system prompt, and finally
 * an optional first-user prompt (trailing positional when the provider
 * declares it).
 */
export function buildAgentArgv(input: AgentLaunchInput): AgentArgv {
  if (input.harness === 'pi') {
    // Overlay replaces the native argv entirely. `provider.args` (Ollama's
    // `run --nowordwrap`) would break Pi if it leaked through. Extras still
    // reach SUBAGENTS only — same rule as the native dialects.
    const extras =
      input.kind === 'subagent'
        ? [...(input.extraMcpServers ?? []), ...(input.extraMcp ?? [])]
        : []
    writePiHarnessMcpConfig(input.mcpUrl, input.cwd, extras)
    const appendSystemPromptFile = writePiHarnessAppendSystemPrompt(
      input.cwd,
      input.systemPrompt
    )
    return {
      argv: buildPiHarnessArgv({
        presetId: input.provider.presetId,
        model: input.model,
        effort: input.effort,
        appendSystemPromptFile,
        initialPrompt: input.initialPrompt
      })
    }
  }
  const { provider } = input
  const argv = [...provider.args]
  argv.push(...buildModelArgs(provider, input.model))
  argv.push(...buildEffortArgs(provider, input.effort))
  if (input.kind === 'subagent' && input.yolo) {
    argv.push(...provider.yoloArgs)
    // Cursor 3.6+ defaults to Auto-review. `--yolo` is only an alias of
    // `--force`; Run Everything also needs the sandbox off. Applied here so a
    // stored provider whose yoloArgs are still just `--yolo` still lands in
    // that mode. Orchestrators never enter this branch.
    if (cursorUsesProjectDialect(provider)) applyCursorRunEverything(argv)
  }
  argv.push(...buildMcpArgs(input))
  const prompt = buildSystemPromptArgs(input)
  argv.push(...prompt.argv)
  argv.push(...buildInitialPromptArgs(provider, input.initialPrompt))
  return { argv, ptySystemPrompt: prompt.ptySystemPrompt }
}

export interface LaunchDeps {
  resolve?: (
    command: string,
    args: string[],
    options?: ResolveLaunchOptions
  ) => Promise<{ file: string; args: string[] }>
  /**
   * Test seam for the bundled Pi CLI. Production calls
   * {@link resolvePiHarnessCli}. Returning undefined falls back to PATH `pi`.
   */
  resolvePiCli?: () => string | undefined
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
  const command = input.harness === 'pi' ? PI_HARNESS_COMMAND : input.provider.command
  const piCli = input.harness === 'pi' ? (deps.resolvePiCli ?? resolvePiHarnessCli)() : undefined
  const resolveCommand = piCli ? process.execPath : command
  const resolveArgs = piCli ? [writePiCliEntry(input.configDir, piCli), ...argv] : argv
  const resolved = await resolve(resolveCommand, resolveArgs, {
    requireFaithfulArgs: needsFaithfulArgs(argv),
    ...(input.platform ? { platform: input.platform } : {})
  })
  const env = buildAgentEnv(input, deps)
  return {
    file: resolved.file,
    args: resolved.args,
    command,
    argv,
    cwd: input.cwd,
    ptySystemPrompt,
    ...(env ? { env } : {})
  }
}

export interface SpawnAgentDeps extends LaunchDeps {
  /** Injectable PTY construction — the workspace tests never touch a process. */
  createPty?: () => AgentPty
  cols?: number
  rows?: number
  /** Injectable trust pre-acceptance; see {@link ensureClaudeWorkspaceTrust}. */
  ensureTrust?: (workspaceDir: string) => void
  /**
   * Injectable Cursor MCP approval write. Production writes
   * `~/.cursor/projects/<slug>/mcp-approvals.json` so the TUI does not stop
   * on every server. Tests pass a spy so they never touch the real home.
   */
  ensureCursorApprovals?: (workspaceDir: string) => void
  /**
   * Injectable Cursor Run Everything project file. Production writes
   * `<cwd>/.cursor/cli.json` for yolo subagents. Tests pass a spy so they
   * can assert the call without depending on disk.
   */
  ensureCursorRunMode?: (workspaceDir: string) => void
}

/**
 * The CLIs that gate a new directory behind an interactive trust prompt, and
 * where each one stores the answer. Keyed on `presetId`, not on the command
 * name: only the shipped presets are known to use these files, and writing
 * into a stranger's config because its command happens to be called `claude`
 * would be a guess.
 *
 * Both dialogs are modal *inside* the CLI and both appear once per worktree,
 * i.e. once per agent — Kimi's was measured eating a whole assignment (see
 * {@link ensureKimiWorkspaceTrust}).
 */
export function trustPreacceptanceFor(
  provider: ProviderConfig
): ((workspaceDir: string) => void) | undefined {
  if (provider.presetId === 'claude') {
    return (dir) => {
      ensureClaudeWorkspaceTrust(dir)
    }
  }
  if (provider.presetId === 'kimi') {
    return (dir) => {
      ensureKimiWorkspaceTrust(dir)
    }
  }
  return undefined
}

/** True when {@link trustPreacceptanceFor} knows this provider's trust store. */
export function needsTrustPreacceptance(provider: ProviderConfig): boolean {
  return trustPreacceptanceFor(provider) !== undefined
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
  const preaccept = input.harness === 'pi' ? undefined : trustPreacceptanceFor(input.provider)
  if (preaccept) {
    const ensureTrust = deps.ensureTrust ?? preaccept
    try {
      ensureTrust(launch.cwd)
    } catch (error) {
      console.warn('[spawn] trust pre-acceptance failed — the CLI may ask:', error)
    }
  }
  // Cursor: `--approve-mcps` is on argv (see buildMcpArgs). The approvals
  // file is the belt that stops the TUI asking for every extra / leftover
  // project server. Pi wrap never writes `.cursor/mcp.json`.
  if (input.harness !== 'pi' && input.provider.mcp.kind === 'cursor-project') {
    const approve = deps.ensureCursorApprovals ?? ensureCursorMcpApprovals
    try {
      approve(launch.cwd)
    } catch (error) {
      console.warn('[spawn] Cursor MCP pre-approval failed — the CLI may ask:', error)
    }
    if (input.kind === 'subagent' && input.yolo) {
      const runMode = deps.ensureCursorRunMode ?? ensureCursorRunEverythingConfig
      try {
        runMode(launch.cwd)
      } catch (error) {
        console.warn('[spawn] Cursor Run Everything config failed — the CLI may ask:', error)
      }
    }
  }
  const pty = deps.createPty ? deps.createPty() : new PtyAgent()
  try {
    pty.spawn({
      file: launch.file,
      args: launch.args,
      cwd: launch.cwd,
      // Overlaid on `process.env` by the PTY; absent for a provider that needs
      // no environment, so an untouched dialect keeps spawning byte-identically.

      ...(launch.env ? { env: launch.env } : {}),
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
