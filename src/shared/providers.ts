/**
 * Provider definitions shared across main / preload / renderer.
 * Pure data + types only — no Node.js imports so the renderer can use it too.
 */

export type AgentProviderId = 'claude' | 'codex' | 'cursor' | 'copilot' | 'ollama'
export type IntegrationProviderId = 'github' | 'cloudflare'
export type ProviderId = AgentProviderId | IntegrationProviderId

export type ProviderKind = 'agent' | 'llm' | 'integration'

export interface ProviderAuthDef {
  /** Official CLI arguments that start the provider-owned login flow. */
  loginArgs: string[]
  /** Non-interactive status command. Omit when the CLI exposes none. */
  statusArgs?: string[]
  loginLabel: string
}

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
  auth?: ProviderAuthDef
  docsUrl?: string
}

export interface ProviderHealth {
  id: ProviderId
  available: boolean
  version?: string
  /** Extra status line, e.g. gh auth account or ollama model count. */
  detail?: string
  /** Account/session state. Ollama remains usable locally without cloud login. */
  connection?: 'connected' | 'disconnected' | 'local' | 'unknown'
  /** True when Orca can open the provider's official CLI login flow. */
  canLogin?: boolean
  /** Provider-specific button text, e.g. "Mit ChatGPT verbinden". */
  loginLabel?: string
  error?: string
  checkedAt: number
}

export type ModelCatalogSource = 'live' | 'fallback' | 'unavailable'

/** Account-aware model choices for one provider. */
export interface ProviderModelCatalogEntry {
  models: string[]
  /** Live is account verified; fallback is curated; unavailable exposes no guesses. */
  source: ModelCatalogSource
  accountDependent: boolean
  /** Short, user-facing explanation of the discovery result. */
  detail?: string
}

export type ProviderModelCatalog = Record<AgentProviderId, ProviderModelCatalogEntry>

/** Canonical registry of everything Orca-Strator can talk to. */
export const PROVIDERS: readonly ProviderDef[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    command: 'claude',
    versionArgs: ['--version'],
    kind: 'agent',
    supportsYolo: true,
    auth: {
      loginArgs: ['auth', 'login'],
      statusArgs: ['auth', 'status'],
      loginLabel: 'Claude verbinden'
    },
    docsUrl: 'https://docs.claude.com/en/docs/claude-code'
  },
  {
    id: 'codex',
    label: 'Codex',
    command: 'codex',
    versionArgs: ['--version'],
    kind: 'agent',
    supportsYolo: true,
    auth: {
      loginArgs: ['login'],
      statusArgs: ['login', 'status'],
      loginLabel: 'Mit ChatGPT verbinden'
    }
  },
  {
    id: 'cursor',
    label: 'Cursor Agent',
    command: 'cursor-agent',
    versionArgs: ['--version'],
    kind: 'agent',
    supportsYolo: true,
    auth: {
      loginArgs: ['login'],
      statusArgs: ['status'],
      loginLabel: 'Cursor verbinden'
    }
  },
  {
    id: 'copilot',
    label: 'GitHub Copilot',
    // The standalone, agentic GitHub Copilot CLI (npm: @github/copilot),
    // NOT the older `gh copilot` extension. Resolved via PATH like the others.
    command: 'copilot',
    versionArgs: ['--version'],
    kind: 'agent',
    supportsYolo: true,
    docsUrl: 'https://www.npmjs.com/package/@github/copilot'
  },
  {
    id: 'ollama',
    label: 'Ollama (local LLMs)',
    command: 'ollama',
    versionArgs: ['--version'],
    kind: 'llm',
    supportsYolo: false,
    auth: {
      loginArgs: ['signin'],
      loginLabel: 'Ollama Cloud verbinden'
    },
    docsUrl: 'https://ollama.com'
  },
  {
    id: 'github',
    label: 'GitHub',
    command: 'gh',
    versionArgs: ['--version'],
    kind: 'integration',
    supportsYolo: false,
    auth: {
      loginArgs: ['auth', 'login'],
      statusArgs: ['auth', 'status'],
      loginLabel: 'GitHub verbinden'
    },
    docsUrl: 'https://cli.github.com'
  },
  {
    id: 'cloudflare',
    label: 'Cloudflare Tunnel',
    command: 'cloudflared',
    versionArgs: ['--version'],
    kind: 'integration',
    supportsYolo: false,
    auth: {
      loginArgs: ['tunnel', 'login'],
      loginLabel: 'Cloudflare verbinden'
    },
    docsUrl: 'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/'
  }
] as const

export function getProvider(id: ProviderId): ProviderDef | undefined {
  return PROVIDERS.find((p) => p.id === id)
}

/**
 * Curated fallbacks used only when live discovery is unavailable.
 *
 * Account-dependent providers should prefer an empty fallback over invented
 * entitlements: Claude and Cursor are populated only from their local account
 * discovery. Codex IDs below are canonical CLI names, but still remain visibly
 * marked as fallback unless the local Codex model cache confirms them.
 *
 * The model input stays free-text for intentional overrides. Leaving it empty
 * uses the provider CLI's own configured default.
 */
export const DEFAULT_MODELS: Record<AgentProviderId, string[]> = {
  // Claude and Cursor are account-dependent. Their picker entries come from
  // live local account caches/CLI discovery; no guessed fallback models.
  claude: [],
  codex: [
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'gpt-5.5',
    'gpt-5.4',
    'gpt-5.4-mini',
    'gpt-5.3-codex-spark'
  ],
  cursor: [],
  // copilot: free-text like the rest; leaving it blank uses the CLI's own
  // default (currently Claude Sonnet). These are just picker suggestions.
  copilot: ['claude-sonnet-4.5', 'gpt-5'],
  ollama: [
    'qwen2.5-coder:32b',
    'qwen2.5-coder:14b',
    'llama3.3:70b',
    'deepseek-coder-v2',
    'codellama:34b'
  ]
}

/** Orca's safe range for its local, per-provider process gates. */
export const PROVIDER_GATE_MIN = 1
export const PROVIDER_GATE_MAX = 16

/**
 * Default per-provider concurrency gates — how many agents of a given provider
 * Orca-Strator may run at once. These are local Orca process gates, not provider
 * API quotas. They are enforced for agent spawns and headless tasks, editable in
 * the Limits panel, and persisted under the `providerLimits` config key.
 */
export const DEFAULT_PROVIDER_LIMITS: Record<AgentProviderId, number> = {
  claude: 4,
  codex: 4,
  cursor: 4,
  copilot: 4,
  ollama: 2
}

export type ProviderLimits = Record<AgentProviderId, number>

const AGENT_PROVIDER_IDS = Object.keys(DEFAULT_PROVIDER_LIMITS) as AgentProviderId[]

function isProviderGateLimit(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= PROVIDER_GATE_MIN &&
    value <= PROVIDER_GATE_MAX
  )
}

/**
 * Resolve a stored config defensively. Corrupt or legacy values fall back to
 * safe defaults so they can never disable a process gate.
 */
export function normalizeProviderLimits(value: unknown): ProviderLimits {
  const limits: ProviderLimits = { ...DEFAULT_PROVIDER_LIMITS }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return limits

  const candidate = value as Record<string, unknown>
  for (const provider of AGENT_PROVIDER_IDS) {
    if (isProviderGateLimit(candidate[provider])) limits[provider] = candidate[provider]
  }
  return limits
}

/**
 * Validate a renderer-supplied gate update before it reaches persistent config.
 * Partial values are allowed for forward-compatible settings writes; omitted
 * providers receive their safe defaults and unknown providers are rejected.
 */
export function parseProviderLimits(value: unknown): ProviderLimits {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Orca-Gates müssen als Objekt angegeben werden.')
  }

  const candidate = value as Record<string, unknown>
  for (const [provider, limit] of Object.entries(candidate)) {
    if (!AGENT_PROVIDER_IDS.includes(provider as AgentProviderId)) {
      throw new Error(`Unbekanntes Orca-Gate: ${provider}`)
    }
    if (!isProviderGateLimit(limit)) {
      throw new Error(
        `Orca-Gate für ${provider} muss eine ganze Zahl zwischen ${PROVIDER_GATE_MIN} und ${PROVIDER_GATE_MAX} sein.`
      )
    }
  }

  return normalizeProviderLimits(candidate)
}
