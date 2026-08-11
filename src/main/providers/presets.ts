/**
 * The five built-in provider presets.
 *
 * These are ordinary {@link ProviderConfig} values, not privileged code paths:
 * a stored config with the same id replaces the preset wholesale (see
 * `mergeProviderConfigs`), which is what makes "edit a built-in" and "reset to
 * preset" possible without a special case anywhere else.
 *
 * Every flag below is taken from the verified launch code of the previous
 * Vertragus generation (`src/main/providers/types.ts` YOLO_FLAGS /
 * buildInteractiveLaunch, `src/shared/providers.ts` PROVIDERS,
 * `src/main/orchestrator/mcpConfig.ts`, `docs/MODELS_AND_EFFORT.md`) — not from
 * documentation guesses. An unknown CLI flag kills a launch, so nothing
 * unverified is declared here.
 */
import {
  providerConfigSchema,
  type ProviderConfig,
  type ProviderPresetId
} from '@shared/schema/provider'

/**
 * Model discovery notes for the file/http sources below:
 * - Claude keeps a partial local cache of the account's extra model options in
 *   `~/.claude.json`. Only the entry values are read; the rolling family
 *   aliases (`opus`, `sonnet`, …) are DERIVED from them in discovery.ts, which
 *   is what keeps a newly released model reachable without an app update.
 *   No API key is ever read — discovery stays local-only by design.
 * - Codex writes the account catalogue to `~/.codex/models_cache.json`.
 * - Kimi answers `kimi provider list --json` with a `models` table whose KEYS
 *   are the aliases.
 * - Cursor prints one model id per line on `cursor-agent models`.
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
    versionArgs: ['--version'],
    auth: { loginArgs: ['auth', 'login'], statusArgs: ['auth', 'status'] },
    systemPromptDelivery: { kind: 'arg', flag: '--append-system-prompt' },
    mcp: {
      kind: 'claude-json',
      configArg: '--mcp-config',
      strictArg: '--strict-mcp-config',
      allowedToolsArg: '--allowedTools'
    },
    modelDiscovery: {
      kind: 'file',
      path: '~/.claude.json',
      parse: 'json',
      jsonPath: 'additionalModelOptionsCache[].value'
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
    // override (`-c model_reasoning_effort="high"`).
    effortArg: { style: 'template', flag: '-c', template: 'model_reasoning_effort="{effort}"' },
    versionArgs: ['--version'],
    auth: { loginArgs: ['login'], statusArgs: ['login', 'status'] },
    systemPromptDelivery: { kind: 'codex-config' },
    mcp: { kind: 'codex-overrides' },
    modelDiscovery: {
      kind: 'file',
      path: '~/.codex/models_cache.json',
      parse: 'json',
      jsonPath: 'models[].slug'
    }
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
    yoloArgs: ['--yolo'],
    modelArg: '--model',
    versionArgs: ['--version'],
    auth: { loginArgs: ['login'], statusArgs: ['status'] },
    // No verified orchestrator/system-prompt flag: the prompt is typed into the
    // PTY after the seed handshake, and MCP is deliberately not attached.
    systemPromptDelivery: { kind: 'pty' },
    mcp: { kind: 'none' },
    modelDiscovery: { kind: 'cli', args: ['models'], parse: 'lines' }
  }),
  providerConfigSchema.parse({
    id: 'ollama',
    presetId: 'ollama',
    label: 'Ollama (local)',
    command: 'ollama',
    // `ollama run <model>` — the model is positional, hence no modelArg.
    args: ['run'],
    yoloArgs: [],
    versionArgs: ['--version'],
    auth: { loginArgs: ['signin'] },
    systemPromptDelivery: { kind: 'pty' },
    mcp: { kind: 'none' },
    modelDiscovery: {
      kind: 'http',
      url: 'http://127.0.0.1:11434/api/tags',
      jsonPath: 'models[].name'
    }
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
