/**
 * Config-driven custom provider descriptors.
 *
 * The built-in providers are a closed, strongly-typed union (AgentProviderId)
 * because the engine special-cases each one. Custom providers are the opposite:
 * a purely declarative contract that lets a user point Vertragus at any
 * additional headless CLI without a core code change. They are namespaced with
 * a `custom:` id prefix so they can never collide with — or be mistaken for —
 * a built-in provider, and they are deliberately WORKER-ONLY: an orchestrator
 * needs the verified in-app MCP channel, which a declarative CLI cannot promise.
 *
 * This module is pure data + validation + launch-spec construction (no Node
 * imports) so main, preload and renderer all share one source of truth.
 */
import { z } from 'zod'

export const CUSTOM_PROVIDER_PREFIX = 'custom:'

/** Built-in ids a custom provider may never shadow. */
const RESERVED_IDS = new Set([
  'claude', 'kimi', 'codex', 'cursor', 'copilot', 'ollama', 'github', 'cloudflare'
])

const promptDelivery = z.enum(['arg', 'stdin'])

export const customProviderConfigSchema = z.object({
  /** Stable id; the `custom:` prefix is enforced and auto-normalized. */
  id: z.string().trim().min(1).max(64),
  label: z.string().trim().min(1).max(80),
  /** Executable resolved via PATH (never a shell string). */
  command: z.string().trim().min(1).max(200),
  /** Args placed before the prompt (e.g. ['-p'] or ['chat', '--json']). */
  args: z.array(z.string().max(200)).max(64).default([]),
  /** How the task prompt reaches the CLI: as the final argv element or on stdin. */
  promptDelivery: promptDelivery.default('arg'),
  /** Auto-approve flags appended when the slot runs in Yolo mode. */
  yoloArgs: z.array(z.string().max(200)).max(16).default([]),
  /** Roles this provider may fill. Orchestrator is intentionally not offered. */
  roles: z.array(z.enum(['worker', 'reviewer', 'tester'])).min(1).default(['worker']),
  /**
   * Whether the CLI understands `--output-format stream-json` (Anthropic-style).
   * Most custom CLIs do not; the plain-text output path is the safe default.
   */
  streamJson: z.boolean().default(false),
  enabled: z.boolean().default(true)
}).strict()

export type CustomProviderConfig = z.infer<typeof customProviderConfigSchema>

export interface CustomProviderLaunch {
  command: string
  args: string[]
  /** Prompt to write to stdin, or undefined when it travels as an argument. */
  stdin?: string
}

export function isCustomProviderId(id: string): boolean {
  return id.startsWith(CUSTOM_PROVIDER_PREFIX)
}

function normalizeId(id: string): string {
  const bare = id.startsWith(CUSTOM_PROVIDER_PREFIX)
    ? id.slice(CUSTOM_PROVIDER_PREFIX.length)
    : id
  return CUSTOM_PROVIDER_PREFIX + bare.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '-')
}

/**
 * Validate and normalize a raw custom-provider list. Invalid entries and ones
 * shadowing a built-in id are dropped (not thrown) so one bad row never breaks
 * the whole config load; duplicate ids keep the first occurrence.
 */
export function parseCustomProviders(raw: unknown): CustomProviderConfig[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const result: CustomProviderConfig[] = []
  for (const entry of raw) {
    const parsed = customProviderConfigSchema.safeParse(entry)
    if (!parsed.success) continue
    const bare = parsed.data.id.replace(CUSTOM_PROVIDER_PREFIX, '').trim().toLowerCase()
    if (RESERVED_IDS.has(bare)) continue
    const id = normalizeId(parsed.data.id)
    if (seen.has(id)) continue
    seen.add(id)
    result.push({ ...parsed.data, id })
  }
  return result
}

/**
 * Build the launch spec for a custom-provider worker. Pure: the prompt is
 * either the final argv element or handed back as `stdin`, never interpolated
 * into a shell string.
 */
export function buildCustomProviderLaunch(
  config: CustomProviderConfig,
  input: { prompt: string; yolo: boolean }
): CustomProviderLaunch {
  const streamArgs = config.streamJson ? ['--output-format', 'stream-json'] : []
  const yoloArgs = input.yolo ? config.yoloArgs : []
  const base = [...config.args, ...streamArgs, ...yoloArgs]
  if (config.promptDelivery === 'stdin') {
    return { command: config.command, args: base, stdin: input.prompt }
  }
  return { command: config.command, args: [...base, input.prompt] }
}
