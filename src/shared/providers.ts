/**
 * Provider definitions shared across main / preload / renderer.
 * Pure data + types only — no Node.js imports so the renderer can use it too.
 */

export type AgentProviderId = 'claude' | 'codex' | 'cursor' | 'ollama'
export type IntegrationProviderId = 'github' | 'cloudflare'
export type ProviderId = AgentProviderId | IntegrationProviderId

export type ProviderKind = 'agent' | 'llm' | 'integration'

export interface ProviderDef {
  id: ProviderId
  label: string
  /** Executable resolved via PATH. */
  command: string
  /** Args used to probe availability / version. */
  versionArgs: string[]
  kind: ProviderKind
  /** Whether Yolo/auto-approve is a meaningful concept for this provider. */
  supportsYolo: boolean
  docsUrl?: string
}

export interface ProviderHealth {
  id: ProviderId
  available: boolean
  version?: string
  /** Extra status line, e.g. gh auth account or ollama model count. */
  detail?: string
  error?: string
  checkedAt: number
}

/** Canonical registry of everything Orca-Strator can talk to. */
export const PROVIDERS: readonly ProviderDef[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    command: 'claude',
    versionArgs: ['--version'],
    kind: 'agent',
    supportsYolo: true,
    docsUrl: 'https://docs.claude.com/en/docs/claude-code'
  },
  {
    id: 'codex',
    label: 'Codex',
    command: 'codex',
    versionArgs: ['--version'],
    kind: 'agent',
    supportsYolo: true
  },
  {
    id: 'cursor',
    label: 'Cursor Agent',
    command: 'cursor-agent',
    versionArgs: ['--version'],
    kind: 'agent',
    supportsYolo: true
  },
  {
    id: 'ollama',
    label: 'Ollama (local LLMs)',
    command: 'ollama',
    versionArgs: ['--version'],
    kind: 'llm',
    supportsYolo: false,
    docsUrl: 'https://ollama.com'
  },
  {
    id: 'github',
    label: 'GitHub',
    command: 'gh',
    versionArgs: ['--version'],
    kind: 'integration',
    supportsYolo: false,
    docsUrl: 'https://cli.github.com'
  },
  {
    id: 'cloudflare',
    label: 'Cloudflare Tunnel',
    command: 'cloudflared',
    versionArgs: ['--version'],
    kind: 'integration',
    supportsYolo: false,
    docsUrl: 'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/'
  }
] as const

export function getProvider(id: ProviderId): ProviderDef | undefined {
  return PROVIDERS.find((p) => p.id === id)
}

/**
 * Model *suggestions* per agent provider — the datalist the ProfileEditor shows.
 * These are suggestions, NOT a validated whitelist: the model field stays
 * free-text, and which models are actually valid depends on each CLI's version
 * and the user's account/subscription. The lists below aim to surface the full
 * catalogue a provider commonly exposes so the user isn't stuck with a single
 * option; models.ts additionally merges live/configured models on top
 * (ollama from the local daemon, codex from ~/.codex/config.toml).
 *
 * codex safety: a wrong model name 400s (e.g. gpt-5.x can be rejected on a
 * ChatGPT-plan account), so the *default* selection for a new codex slot stays
 * empty = "use codex's own configured default" (see defaultModelFor in the
 * ProfileEditor and DEFAULT_PROFILE). The names here are only pickable hints.
 * Claude aliases (opus/sonnet/haiku/fable) are stable across accounts.
 */
export const DEFAULT_MODELS: Record<AgentProviderId, string[]> = {
  claude: [
    'fable',
    'opus',
    'sonnet',
    'haiku',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-sonnet-5',
    'claude-sonnet-4-6',
    'claude-haiku-4-5',
    'claude-fable-5'
  ],
  codex: ['gpt-5.6-codex', 'gpt-5.6', 'gpt-5.1-codex', 'gpt-5.1', 'o4-mini', 'o3'],
  cursor: [
    'composer',
    'auto',
    'gpt-5.6',
    'claude-sonnet-5',
    'claude-opus-4-8',
    'gemini-2.5-pro'
  ],
  ollama: [
    'qwen2.5-coder:32b',
    'qwen2.5-coder:14b',
    'llama3.3:70b',
    'deepseek-coder-v2',
    'codellama:34b'
  ]
}

/**
 * Default per-provider concurrency limits — how many agents of a given provider
 * the user wants to run at once. Purely a user-facing budget shown live in the
 * Limits panel (Limits & Nutzung); persisted under the `providerLimits` config
 * key and editable in the UI. Not a hard cap on spawning.
 */
export const DEFAULT_PROVIDER_LIMITS: Record<AgentProviderId, number> = {
  claude: 4,
  codex: 4,
  cursor: 4,
  ollama: 2
}
