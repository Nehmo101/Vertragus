/**
 * Provider descriptors — ONE declarative schema for the built-in presets and
 * for user-defined CLIs.
 *
 * The old repo split this in two: a closed, hard-coded union of built-in
 * providers that the engine special-cased everywhere, plus a separate
 * `customProviderConfigSchema` for everything else. That is why adding a
 * provider meant touching launch, health, discovery and the picker. Here a
 * provider is *only* data: how to start it, how to make it yolo, how it takes a
 * model, a system prompt and an MCP attachment, and where its model list comes
 * from. The presets in `@main/providers/presets` are ordinary values of this
 * schema carrying a `presetId`, so the editor can offer "reset to preset"
 * without any of them being privileged at runtime.
 *
 * Pure data + zod only (no Node imports) so main, preload and renderer share
 * one source of truth.
 */
import { z } from 'zod'

/** Editable built-ins. A stored config with the same id overrides its preset. */
export const PROVIDER_PRESET_IDS = ['claude', 'codex', 'kimi', 'cursor', 'grok', 'ollama'] as const
export type ProviderPresetId = (typeof PROVIDER_PRESET_IDS)[number]
export const providerPresetIdSchema = z.enum(PROVIDER_PRESET_IDS)

/**
 * Canonical effort ladder. Deliberately three rungs: `low|medium|high` are the
 * only levels both CLIs that expose the knob agree on (Claude `--effort`,
 * Codex `-c model_reasoning_effort`), so nothing ever has to be clamped down
 * into an unknown flag — which kills a launch.
 */
export const EFFORT_LEVELS = ['low', 'medium', 'high'] as const
export type EffortLevel = (typeof EFFORT_LEVELS)[number]
export const effortLevelSchema = z.enum(EFFORT_LEVELS)

const MAX_ARG_LENGTH = 400
const MAX_ARGS = 64

const flagSchema = z.string().trim().min(1).max(200)
const argListSchema = z.array(z.string().max(MAX_ARG_LENGTH)).max(MAX_ARGS)
const pathSchema = z.string().trim().min(1).max(400)

/**
 * How the effort level reaches the CLI.
 * - `flag`: a plain pair, e.g. `--effort high` (Claude Code).
 * - `template`: one argument built from a template, e.g.
 *   `-c model_reasoning_effort="high"` (Codex `-c key=value` surface).
 */
export const effortArgSchema = z.discriminatedUnion('style', [
  z.object({ style: z.literal('flag'), flag: flagSchema }).strict(),
  z
    .object({
      style: z.literal('template'),
      flag: flagSchema,
      /** Must contain `{effort}`; the level is substituted verbatim. */
      template: z
        .string()
        .min(1)
        .max(200)
        .refine((value) => value.includes('{effort}'), {
          message: 'effort template must contain {effort}'
        })
    })
    .strict()
])
export type EffortArg = z.infer<typeof effortArgSchema>

/**
 * How the role/orchestrator system prompt is delivered at launch.
 * - `arg`: appended via a CLI flag (`--append-system-prompt`).
 * - `agent-file`: written to a file whose path is passed via a flag (Kimi).
 * - `codex-config`: Codex' `-c developer_instructions=…` process-local config.
 * - `pty`: no launch surface at all — the text is typed into the terminal
 *   (Cursor, Ollama). The seed handshake is what makes this reliable.
 */
export const systemPromptDeliverySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('arg'), flag: flagSchema }).strict(),
  z.object({ kind: z.literal('agent-file'), flag: flagSchema }).strict(),
  z.object({ kind: z.literal('codex-config') }).strict(),
  z.object({ kind: z.literal('pty') }).strict()
])
export type SystemPromptDelivery = z.infer<typeof systemPromptDeliverySchema>

/**
 * How a first user prompt (the workspace start-goal) is passed at spawn.
 * Absent = the host types it into the PTY after boot (`assignGoal`).
 *
 * - `positional`: trailing argv string. That is an interactive first turn,
 *   not headless `-p` / `--single` (those exit after one turn).
 */
export const initialPromptDeliverySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('positional') }).strict()
])
export type InitialPromptDelivery = z.infer<typeof initialPromptDeliverySchema>

/**
 * How the Vertragus MCP server is attached. Every spawn makes this decision
 * explicitly — `none` is a declaration, never an accident (that omission is the
 * old repo's communicatively dead subagent bug).
 */
export const mcpAttachSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('claude-json'),
      /** Flag receiving a transient `{ mcpServers: … }` JSON file. */
      configArg: flagSchema,
      /** Flag restricting the CLI to exactly that file (orchestrator). */
      strictArg: flagSchema.optional(),
      /** Flag pre-approving the Vertragus tools. */
      allowedToolsArg: flagSchema.optional()
    })
    .strict(),
  z.object({ kind: z.literal('codex-overrides') }).strict(),
  z.object({ kind: z.literal('kimi-project') }).strict(),
  /** Project-scoped `.cursor/mcp.json` merge + `--approve-mcps` (see mcp/attach). */
  z.object({ kind: z.literal('cursor-project') }).strict(),
  /**
   * Project-scoped `.grok/config.toml` merge of `[mcp_servers.vertragus]` plus
   * `--allow MCPTool(vertragus__*)` so the loopback server is usable without a
   * TUI approval. Orchestrator launches also get a permission cage (see mcp/attach).
   */

  z.object({ kind: z.literal('grok-project') }).strict(),
  z.object({ kind: z.literal('none') }).strict()
])
export type McpAttach = z.infer<typeof mcpAttachSchema>

/**
 * Where the model list comes from. Never a hard-coded catalogue: a provider
 * that ships a new model must show up without a Vertragus release.
 *
 * `jsonPath` is a tiny walker path (`models[].name`, `additionalModelOptionsCache[].value`,
 * or just `models` for a keyed table) — see `@main/providers/discovery`.
 */
export const modelDiscoverySchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('cli'),
      args: argListSchema,
      parse: z.enum(['lines', 'json']),
      jsonPath: z.string().max(200).optional()
    })
    .strict(),
  z
    .object({
      kind: z.literal('file'),
      /** `~` is expanded to the user's home directory. */
      path: pathSchema,
      parse: z.enum(['json', 'toml-keys']),
      jsonPath: z.string().max(200).optional()
    })
    .strict(),
  z
    .object({
      kind: z.literal('http'),
      url: z.string().url().max(400),
      jsonPath: z.string().min(1).max(200)
    })
    .strict(),
  z.object({ kind: z.literal('none') }).strict()
])
export type ModelDiscovery = z.infer<typeof modelDiscoverySchema>

export const providerAuthSchema = z
  .object({
    /** Args that start the provider-owned login flow (opened in a terminal). */
    loginArgs: argListSchema.default([]),
    /** Non-interactive status probe. Omit when the CLI exposes none. */
    statusArgs: argListSchema.optional()
  })
  .strict()
export type ProviderAuth = z.infer<typeof providerAuthSchema>

/**
 * Per-provider tuning for the interactive seed handshake.
 *
 * Only the submit side is exposed here: a PTY-delivery provider that pastes a
 * multi-KB role prompt (Cursor) needs a longer pause before Enter, otherwise
 * the keypress is swallowed as a newline of the still-digesting paste. Retries
 * and watch windows live on the handshake itself with safe defaults; presets
 * only override what they have measured.
 */
export const providerSeedSchema = z
  .object({
    /** Ms to wait after the prompt text before the first Enter. */
    submitDelayMs: z.number().int().positive().max(10_000).optional(),
    /** Max Enter presses including the first. */
    submitRetries: z.number().int().min(1).max(10).optional(),
    /** Base watch window after each Enter before deciding to retry. */
    submitWatchMs: z.number().int().positive().max(10_000).optional(),
    /**
     * What counts as "the Enter was accepted".
     * - `'buffer-change'` (default): any PTY output inside the watch window
     *   stops further Enters — right for CLIs that stay quiet on a swallow.
     * - `'sustained-activity'`: only ongoing output counts. For TUIs that
     *   redraw once even after swallowing the keypress (cursor-agent renders
     *   its paste chip and then goes silent), while an accepted Enter starts a
     *   turn that streams output for seconds. Also switches the handshake to a
     *   single text write and settle-gated Enters — the full mechanics live on
     *   the handshake (`@main/agents/interactiveReady`).
     */
    submitAcceptance: z.enum(['buffer-change', 'sustained-activity']).optional(),
    /**
     * Whether the assignment may travel as a real bracketed paste.
     * - `'auto'` (default): framed in `ESC[200~`/`ESC[201~` as soon as the CLI
     *   announces DECSET 2004, so no newline of a multi-KB role prompt can be
     *   decoded as Enter no matter how the PTY chunks the write.
     * - `'never'`: raw write only — the opt-out for a CLI that turns bracketed
     *   paste on but mishandles the markers.
     */
    bracketedPaste: z.enum(['auto', 'never']).optional(),
    /**
     * Cap on waiting for the CLI to take the keyboard (its DECSET 2004
     * announcement) before the assignment is written. `0` skips that wait —
     * only correct for a CLI that never announces, e.g. a plain REPL like
     * `ollama run`, where waiting out the cap would be pure delay. Leaving it
     * unset keeps the handshake default, which is what every TUI wants.
     */
    keyboardWaitMs: z.number().int().min(0).max(60_000).optional()
  })
  .strict()
export type ProviderSeed = z.infer<typeof providerSeedSchema>

export const providerConfigSchema = z
  .object({
    /** Stable id, normalized to `[a-z0-9._-]`. Presets use their preset id. */
    id: z.string().trim().min(1).max(64),
    /** Set when this config came from (or overrides) a built-in preset. */
    presetId: providerPresetIdSchema.optional(),
    label: z.string().trim().min(1).max(80),
    /** Executable resolved via PATH — never a shell string. */
    command: z.string().trim().min(1).max(200),
    /** Args placed before everything else on every launch. */
    args: argListSchema.default([]),
    /** Appended when the agent runs in Yolo mode. Empty = no yolo surface. */
    yoloArgs: argListSchema.default([]),
    /** Flag taking the model id. Absent = the model is a positional argument. */
    modelArg: flagSchema.optional(),
    effortArg: effortArgSchema.optional(),
    versionArgs: argListSchema.default(['--version']),
    auth: providerAuthSchema.optional(),
    systemPromptDelivery: systemPromptDeliverySchema.default({ kind: 'pty' }),
    /** Spawn-time first user prompt. Absent = PTY `assignGoal` after boot. */
    initialPromptDelivery: initialPromptDeliverySchema.optional(),
    mcp: mcpAttachSchema.default({ kind: 'none' }),
    /**
     * How long ONE MCP tool call may run on this CLI, in seconds, once the
     * launch layer has raised the limit. Absent = the CLI keeps its own default
     * (60 s in every CLI shipped here), which is what caps the orchestrator's
     * `await_events` long poll at 50 s.
     *
     * A capability claim, not a wish: setting it means "the spawn/attach layer
     * knows how to raise THIS CLI's tool timeout, process-locally" — Claude's
     * `MCP_TIMEOUT`/`MCP_TOOL_TIMEOUT` env pair, Codex' per-server
     * `tool_timeout_sec` override. A dialect with no known mechanism ignores
     * the number, and nothing is ever written to a user-global config.
     *
     * It lives here and not inside `mcp` because that union is strict and
     * per-dialect: the field would have to be repeated in every variant
     * (including `none`, where it means nothing) or force a narrowing at every
     * read site. It stays DATA on the provider so a custom Claude-compatible
     * CLI can opt in without a Vertragus release.
     *
     * Why it matters: every empty `await_events` return costs the orchestrator
     * a full model pass over its whole context. A ten-minute poll is an order
     * of magnitude fewer idle turns than a fifty-second one — the single
     * biggest token lever in the loop.
     */
    mcpToolTimeoutSec: z.number().int().positive().max(3600).optional(),
    modelDiscovery: modelDiscoverySchema.default({ kind: 'none' }),
    /**
     * Ids that are ALWAYS offered, merged behind whatever discovery found.
     *
     * This is not a model catalogue and must never become one: the only ids
     * that belong here are a CLI's own ROLLING aliases (`opus`, `sonnet`), which
     * the provider resolves server-side to that family's current release. They
     * never name a release, so they cannot go stale and cannot hide a new model.
     *
     * They exist because a discovery source can be truthful and still be far too
     * narrow — `~/.claude.json` only caches the account's EXTRA options, so a
     * machine whose `modelAccessCache` is empty ends up with a two-entry picker
     * although the CLI happily runs every family. A seed keeps the picker
     * usable without pretending to know which releases exist.
     */
    seedModels: z.array(z.string().trim().min(1).max(200)).max(MAX_ARGS).default([]),
    /** Optional seed-handshake overrides; see {@link providerSeedSchema}. */
    seed: providerSeedSchema.optional(),
    enabled: z.boolean().default(true)
  })
  .strict()

export type ProviderConfig = z.infer<typeof providerConfigSchema>
export type ProviderConfigInput = z.input<typeof providerConfigSchema>

/** Lowercase, punctuation-safe id so a hand-edited config cannot smuggle one in. */
export function normalizeProviderId(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Validate and normalize a raw provider list. Invalid entries are dropped, not
 * thrown: one hand-edited row must never take the whole config down. Duplicate
 * ids keep the first occurrence.
 */
export function parseProviderConfigs(raw: unknown): ProviderConfig[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const result: ProviderConfig[] = []
  for (const entry of raw) {
    const parsed = providerConfigSchema.safeParse(entry)
    if (!parsed.success) continue
    const id = normalizeProviderId(parsed.data.id)
    if (!id || seen.has(id)) continue
    seen.add(id)
    result.push({ ...parsed.data, id })
  }
  return result
}

/**
 * Presets merged with stored configs: a stored entry with the same id REPLACES
 * its preset (that is how "edit a built-in" works), unknown stored ids are
 * appended as custom providers. Preset order is preserved so the picker stays
 * stable.
 */
export function mergeProviderConfigs(
  presets: readonly ProviderConfig[],
  stored: readonly ProviderConfig[]
): ProviderConfig[] {
  const overrides = new Map(stored.map((config) => [config.id, config]))
  const merged: ProviderConfig[] = presets.map((preset) => overrides.get(preset.id) ?? preset)
  const presetIds = new Set(presets.map((preset) => preset.id))
  for (const config of stored) {
    if (!presetIds.has(config.id)) merged.push(config)
  }
  return merged
}

/**
 * Model argument for a launch. Providers without a `modelArg` (Ollama's
 * `ollama run <model>`) take the id positionally after `args`.
 */
export function buildModelArgs(
  config: Pick<ProviderConfig, 'modelArg'>,
  model: string | undefined
): string[] {
  const id = model?.trim()
  if (!id) return []
  return config.modelArg ? [config.modelArg, id] : [id]
}

/** Effort argument for a launch; empty when the provider exposes no knob. */
export function buildEffortArgs(
  config: Pick<ProviderConfig, 'effortArg'>,
  effort: EffortLevel | undefined
): string[] {
  if (!effort || !config.effortArg) return []
  if (config.effortArg.style === 'flag') return [config.effortArg.flag, effort]
  return [config.effortArg.flag, config.effortArg.template.replace('{effort}', effort)]
}

/**
 * First-user-prompt arguments for a launch. Empty when the provider has no
 * spawn-time surface or the prompt is blank. Never emits `-p` / `--single`.
 */
export function buildInitialPromptArgs(
  config: Pick<ProviderConfig, 'initialPromptDelivery'>,
  prompt: string | undefined
): string[] {
  const text = prompt?.trim()
  if (!text || !config.initialPromptDelivery) return []
  switch (config.initialPromptDelivery.kind) {
    case 'positional':
      return [text]
  }
}

/**
 * Remembered model catalogue: `{ providerId: { modelId: lastSeenAtMs } }`.
 * Lives here (not in discovery) because the settings store persists it and must
 * stay importable without any Node/Electron dependency.
 */
export const modelMemorySchema = z.record(
  z.string().min(1).max(64),
  z.record(z.string().min(1).max(200), z.number().finite())
)
export type ModelMemory = z.infer<typeof modelMemorySchema>
