/**
 * The six built-in provider presets.
 *
 * These are ordinary {@link ProviderConfig} values, not privileged code paths:
 * a stored config with the same id replaces the preset wholesale (see
 * `mergeProviderConfigs`), which is what makes "edit a built-in" and "reset to
 * preset" possible without a special case anywhere else.
 *
 * Every flag below is taken from the verified launch code of the previous
 * Vertragus generation (the Vertragus-Archiv repository: its
 * `src/main/providers/types.ts` YOLO_FLAGS / buildInteractiveLaunch,
 * `src/shared/providers.ts` PROVIDERS, `src/main/orchestrator/mcpConfig.ts`
 * and its model/effort notes; the current model discovery story lives in
 * README.md "Providers") — not from
 * documentation guesses. An unknown CLI flag kills a launch, so nothing
 * unverified is declared here. Grok Build is the exception that was added
 * after that generation: its flags come from the published CLI reference
 * (https://docs.x.ai/build/cli/reference) and the MCP / settings docs, which
 * list `--always-approve`, `--model`, `--effort`, `--append-system-prompt`
 * (alias of `--rules`), a positional string as the interactive first prompt
 * (never `-p`/`--single`), `grok --version`, `grok login` and `grok models`.
 */
import {
  providerConfigSchema,
  type ProviderConfig,
  type ProviderPresetId
} from '@shared/schema/provider'

/**
 * Which CLI version each preset was last verified against. The data lives in
 * `@shared/presetVerification` so the renderer's provider editor can show a
 * drift hint without importing main-process code; it is re-exported here
 * because this file is where the presets — and their verification notes in the
 * comments below — are defined.
 */
export { PRESET_VERIFICATION, type PresetVerification } from '@shared/presetVerification'

/**
 * Model discovery notes for the file/http sources below:
 * - Claude keeps a partial local cache of the account's extra model options in
 *   `~/.claude.json`. Only the entry values are read; the rolling family
 *   aliases (`opus`, `sonnet`, …) are DERIVED from them in discovery.ts, which
 *   is what keeps a newly released model reachable without an app update.
 *   No API key is ever read — discovery stays local-only by design.
 * - Codex writes the account catalogue to `~/.codex/models_cache.json`.
 * - Kimi answers `kimi provider list --json` with a `models` table whose KEYS
 *   (`kimi-code/k3`, not the nested `model` field) are what `--model` accepts.
 * - Cursor prints `<id> - <label>` per line on `cursor-agent models`.
 * - Grok Build prints its catalogue on `grok models` (built-in xAI models plus
 *   any `[model.*]` entries in `~/.grok/config.toml`).
 * - Ollama is a local service; its tags endpoint is the only truth about which
 *   models physically exist on this machine.
 */
const PRESETS: readonly ProviderConfig[] = [
  providerConfigSchema.parse({
    id: 'claude',
    presetId: 'claude',
    label: 'Claude Code',
    command: 'claude',
    yoloArgs: ['--dangerously-skip-permissions'],
    modelArg: '--model',
    effortArg: { style: 'flag', flag: '--effort' },
    // Claude Code `--effort` (verified 2.1.238): low, medium, high, xhigh, max.
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    versionArgs: ['--version'],
    auth: { loginArgs: ['auth', 'login'], statusArgs: ['auth', 'status'] },
    systemPromptDelivery: { kind: 'arg', flag: '--append-system-prompt' },
    mcp: {
      kind: 'claude-json',
      configArg: '--mcp-config',
      strictArg: '--strict-mcp-config',
      allowedToolsArg: '--allowedTools'
    },
    /**
     * Claude Code reads `MCP_TIMEOUT` / `MCP_TOOL_TIMEOUT` (milliseconds) from
     * its own environment, so the raise is process-local — the spawn layer sets
     * the pair, nothing touches `~/.claude/settings.json`. Ten minutes is the
     * point where the orchestrator's `await_events` stops being a metronome:
     * one long poll instead of ~12 empty 50 s ones, each of which would cost a
     * full model pass over the whole orchestrator context.
     */
    mcpToolTimeoutSec: 600,
    modelDiscovery: {
      kind: 'file',
      path: '~/.claude.json',
      parse: 'json',
      jsonPath: 'additionalModelOptionsCache[].value'
    },
    /**
     * The three rolling aliases of the Claude CLI.
     *
     * This is NOT a hard-coded model list — that rule stands. `opus`, `sonnet`
     * and `haiku` name no release; the CLI resolves each one server-side to the
     * newest model of that family, so they keep working across releases and can
     * never hide a model discovery finds.
     *
     * They are needed because `~/.claude.json` is a cache of the account's
     * ADDITIONAL options only. On a machine whose `modelAccessCache` is `[]` and
     * whose `additionalModelOptionsCache` holds a single entry, discovery is
     * correct and the picker still offers two ids — with no way to pick the
     * standard families. Discovery results always come first; a seed only fills
     * a gap.
     */
    seedModels: ['opus', 'sonnet', 'haiku'],
    // Verified claude 2.1.261 — `--session-id <uuid>` pins the file name
    // under `~/.claude/projects/<slug>/`.
    usageSource: {
      kind: 'claude-jsonl',
      dir: '~/.claude/projects',
      sessionIdArg: '--session-id'
    }
  }),
  providerConfigSchema.parse({
    id: 'codex',
    presetId: 'codex',
    label: 'Codex',
    command: 'codex',
    yoloArgs: ['--dangerously-bypass-approvals-and-sandbox'],
    modelArg: '--model',
    // Codex has no --effort flag; the level travels as a process-local config
    // override (`-c model_reasoning_effort="high"`). xhigh is a documented Codex
    // rung; the cache has no per-model list, so this fallback is the picker.
    effortArg: { style: 'template', flag: '-c', template: 'model_reasoning_effort="{effort}"' },
    effortLevels: ['low', 'medium', 'high', 'xhigh'],
    versionArgs: ['--version'],
    auth: { loginArgs: ['login'], statusArgs: ['login', 'status'] },
    systemPromptDelivery: { kind: 'codex-config' },
    mcp: { kind: 'codex-overrides' },
    // No `mcpToolTimeoutSec` on purpose. Newer Codex builds take a per-server
    // `tool_timeout_sec`, and the attach layer emits the `-c` override the
    // moment this field is set — but nothing here verified how an OLDER codex
    // reacts to an unknown key under `mcp_servers.*`, and a rejected override
    // is a launch that never starts. The mechanism ships, the claim does not:
    // a user on a recent codex opts in by editing this preset.
    modelDiscovery: {
      kind: 'file',
      path: '~/.codex/models_cache.json',
      parse: 'json',
      jsonPath: 'models[].slug'
    },
    // Codex 0.153.3 has no launch session-id flag, only `codex resume`.
    usageSource: { kind: 'codex-rollout', dir: '~/.codex/sessions' }
  }),
  providerConfigSchema.parse({
    id: 'kimi',
    presetId: 'kimi',
    label: 'Kimi Code',
    command: 'kimi',
    yoloArgs: ['--yolo'],
    modelArg: '--model',
    // Kimi Code has no verified CLI effort switch — depth comes from the model
    // id or config.toml [thinking]. Declaring one would kill the launch.
    versionArgs: ['--version'],
    // `kimi login` is a device-code flow; the CLI exposes no status command.
    auth: { loginArgs: ['login'] },
    systemPromptDelivery: { kind: 'agent-file', flag: '--agent-file' },
    mcp: { kind: 'kimi-project' },
    modelDiscovery: {
      kind: 'cli',
      args: ['provider', 'list', '--json'],
      parse: 'json',
      jsonPath: 'models'
    }
  }),
  providerConfigSchema.parse({
    id: 'cursor',
    presetId: 'cursor',
    label: 'Cursor Agent',
    command: 'cursor-agent',
    // Workspace trust: a fresh directory blocks on a TUI modal before anything
    // runs. Verified `--trust` suppresses it (cursor-agent 2026.08.11). Trust is
    // a launch concern, not an MCP concern — parallel to Claude's
    // `needsTrustPreacceptance` (state-file) path; Cursor has a flag instead.
    args: ['--trust'],
    // Run Everything: `--force` (`--yolo` is the alias) plus sandbox off.
    // Auto-review is the Cursor 3.6+ default; `--yolo` alone still prompts
    // on tool calls that cannot run inside the sandbox. Spawn applies these
    // to every native Cursor launch, including orchestrators — Cursor has no
    // per-tool allow-list, and Auto-review otherwise still blocks MCP.
    yoloArgs: ['--force', '--sandbox', 'disabled'],
    modelArg: '--model',
    versionArgs: ['--version'],
    auth: { loginArgs: ['login'], statusArgs: ['status'] },
    // No verified system-prompt flag: the role/orchestrator prompt is still
    // typed into the PTY after the seed handshake. MCP attach
    // (`cursor-project`) and prompt delivery are orthogonal.
    systemPromptDelivery: { kind: 'pty' },
    mcp: { kind: 'cursor-project' },
    modelDiscovery: { kind: 'cli', args: ['models'], parse: 'lines' },
    /**
     * The one rolling alias of the Cursor CLI — `auto`, which routes to
     * whatever model Cursor currently considers best (see `@shared/models`,
     * where it is listed as an alias next to Claude's `opus`/`sonnet`).
     *
     * Cursor was the only CLI/file provider with no seed at all, and its
     * discovery is the one that fails hardest: `cursor-agent models` needs a
     * logged-in account, so on a fresh machine the CLI reports its version
     * happily (the provider shows as healthy) while the picker has zero
     * entries. One rolling alias is what makes the provider startable in that
     * state; discovery results still come first and always win the order.
     */
    seedModels: ['auto'],
    // Role prompt + task are pasted as one multi-KB block. Measured against
    // the real CLI (v2026.08.11, PTY probe): while digesting the paste the TUI
    // freezes for >1s, an Enter that lands mid-digestion is swallowed — yet
    // still triggers a redraw (the "[Pasted text …]" chip), so the default
    // 'buffer-change' acceptance read the swallow as success and never
    // retried; and an Enter pressed into the freeze or into a running turn
    // queues the composer content as an EXTRA follow-up turn. Hence
    // 'sustained-activity': one text write, every Enter gated on a settled
    // buffer, and only seconds-long output (a turn's spinner) stops the
    // bounded retries. The wide watch window gives the sustain check room.
    //
    // All of that is timing, and timing was only half of it: the block also has
    // to arrive as a *paste*. Written raw it is a keystroke stream that the PTY
    // splits into read-sized chunks, and every `\n` of the role prompt that
    // lands on a chunk boundary is decoded as Enter — which submits a fragment
    // and leaves the rest behind, the failure that survived the timing fix.
    // `bracketedPaste: 'auto'` (the default, spelled out here because Cursor is
    // where it was diagnosed) frames the block in ESC[200~/ESC[201~ as soon as
    // cursor-agent announces DECSET 2004, so its content cannot be read as keys
    // at all and the separate Enter is the only keypress in the sequence.
    seed: {
      submitDelayMs: 750,
      submitRetries: 3,
      submitWatchMs: 2500,
      submitAcceptance: 'sustained-activity',
      bracketedPaste: 'auto'
    }
  }),
  providerConfigSchema.parse({
    id: 'grok',
    presetId: 'grok',
    label: 'Grok Build',
    command: 'grok',
    yoloArgs: ['--always-approve'],
    modelArg: '--model',
    effortArg: { style: 'flag', flag: '--effort' },
    // Per-model rungs come from the sidecar cache. grok-build / grok-4.3 /
    // empty (CLI default) have no cache entry, so this fallback is the picker.
    effortLevels: ['low', 'medium', 'high', 'xhigh'],
    versionArgs: ['--version'],
    // `grok login` is browser/device-code OAuth; the CLI exposes no status probe.
    auth: { loginArgs: ['login'] },
    // `--append-system-prompt` is the documented Claude-compatible alias of
    // `--rules`: extra instructions appended for this session, not a replacement
    // of the coding-agent prompt (`--system-prompt-override` would drop it).
    systemPromptDelivery: { kind: 'arg', flag: '--append-system-prompt' },
    // `grok` with no args opens the welcome screen; a trailing positional
    // string is the interactive first turn. Never `-p`/`--single` — those
    // are headless and exit after one turn.
    initialPromptDelivery: { kind: 'positional' },
    mcp: { kind: 'grok-project' },
    modelDiscovery: { kind: 'cli', args: ['models'], parse: 'lines' },
    /**
     * Per-model `reasoning_efforts` live in the local Grok models cache. Ids
     * still come from `grok models` (so the grok-build alias stays); this
     * file only attaches effort rungs and is never a second catalogue.
     */
    effortDiscovery: {
      kind: 'file',
      path: '~/.grok/models_cache.json',
      parse: 'json',
      jsonPath: 'models'
    },
    /**
     * The rolling coding-agent alias of the Grok CLI — `grok-build`, which the
     * CLI resolves to whatever currently powers Grok Build (see
     * https://docs.x.ai/build/overview). Like Cursor's `auto`, it names no
     * release.
     *
     * `grok models` needs a signed-in session or `XAI_API_KEY`, so a healthy
     * `--version` probe can still produce an empty picker on a fresh machine.
     * One rolling alias keeps the provider startable; discovery still wins
     * the order when it answers.
     */
    seedModels: ['grok-build'],
    // grok 1.0.13 `-s/--session-id <uuid>`; the log records context
    // occupancy only, hence `kind: 'context'` readings.
    usageSource: {
      kind: 'grok-session',
      dir: '~/.grok/sessions',
      sessionIdArg: '--session-id'
    }
  }),
  providerConfigSchema.parse({
    id: 'ollama',
    presetId: 'ollama',
    label: 'Ollama (local)',
    command: 'ollama',
    // `ollama run --nowordwrap <model>` — the model is positional, hence no modelArg.
    // `--nowordwrap` (verified ollama 0.30.11) removes Ollama-side wrapping so
    // the sentinel parser only has to rejoin terminal-width wraps.
    args: ['run', '--nowordwrap'],
    yoloArgs: [],
    versionArgs: ['--version'],
    auth: { loginArgs: ['signin'] },
    systemPromptDelivery: { kind: 'pty' },
    mcp: { kind: 'none' },
    modelDiscovery: {
      kind: 'http',
      url: 'http://127.0.0.1:11434/api/tags',
      jsonPath: 'models[].name'
    },
    // `ollama run` is a line REPL, not a TUI: it never announces DECSET 2004,
    // so waiting for the keyboard announcement would only ever time out. The
    // idle heuristic is the right readiness signal here — and the correct one,
    // because a REPL reads stdin from its first prompt onwards.
    seed: { keyboardWaitMs: 0 }
  })
]

/** Fresh copies, so a caller mutating a preset cannot poison the registry. */
export function providerPresets(): ProviderConfig[] {
  return PRESETS.map((preset) => structuredClone(preset))
}

/** One preset by its id, or undefined for an unknown/custom id. */
export function providerPreset(id: ProviderPresetId | string): ProviderConfig | undefined {
  const preset = PRESETS.find((candidate) => candidate.id === id)
  return preset ? structuredClone(preset) : undefined
}
