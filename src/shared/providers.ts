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

export type ModelCatalogSource = 'live' | 'mixed' | 'fallback' | 'unavailable'

/** Account-aware model choices for one provider. */
export interface ProviderModelCatalogEntry {
  models: string[]
  /** Live comes from the installed provider, mixed adds curated suggestions. */
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
 * These values are picker suggestions, not a whitelist. Provider discovery may
 * replace them with an account/local catalogue (Codex, Cursor, Ollama) or merge
 * additional options into them (Claude). This keeps stable CLI aliases visible
 * even when a provider cache only contains experimental/additional models.
 *
 * The model input stays free-text for intentional overrides. Leaving it empty
 * uses the provider CLI's own configured default.
 */
export const DEFAULT_MODELS: Record<AgentProviderId, string[]> = {
  claude: [
    'sonnet',
    'opus',
    'haiku',
    'fable',
    'claude-sonnet-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-sonnet-4-6',
    'claude-haiku-4-5',
    'claude-fable-5'
  ],
  codex: [
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'gpt-5.5',
    'gpt-5.4',
    'gpt-5.4-mini',
    'gpt-5.3-codex-spark'
  ],
  // Used only when `cursor-agent models` cannot return the account catalogue.
  cursor: [
    'auto',
    'composer-2.5',
    'composer-2.5-fast',
    'gpt-5.3-codex',
    'claude-opus-4-8-high',
    'claude-sonnet-5',
    'gemini-3.1-pro'
  ],
  // IDs documented by the standalone @github/copilot CLI. Account and
  // organization policies may still restrict individual entries.
  copilot: [
    'auto',
    'claude-sonnet-4.6',
    'gpt-5.4',
    'claude-haiku-4.5',
    'gpt-5.3-codex',
    'gemini-3.1-pro-preview',
    'gemini-3.5-flash',
    'mai-code-1-flash'
  ],
  ollama: [
    'qwen2.5-coder:32b',
    'qwen2.5-coder:14b',
    'llama3.3:70b',
    'deepseek-coder-v2',
    'codellama:34b'
  ]
}

/** Orca's safe range for its local, per-provider process gates. */
export const PROVIDER_GATE_UNLIMITED = 0
export const PROVIDER_GATE_MIN = PROVIDER_GATE_UNLIMITED
export const PROVIDER_GATE_MAX = Number.MAX_SAFE_INTEGER

/**
 * Default per-provider concurrency gates — how many agents of a given provider
 * Orca-Strator may run at once. These are local Orca process gates, not provider
 * API quotas. They are enforced for agent spawns and headless tasks, editable in
 * the Limits panel, and persisted under the `providerLimits` config key.
 */
export const DEFAULT_PROVIDER_LIMITS: Record<AgentProviderId, number> = {
  claude: PROVIDER_GATE_UNLIMITED,
  codex: PROVIDER_GATE_UNLIMITED,
  cursor: PROVIDER_GATE_UNLIMITED,
  copilot: PROVIDER_GATE_UNLIMITED,
  ollama: PROVIDER_GATE_UNLIMITED
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

export type ProviderEnabled = Record<AgentProviderId, boolean>
export type DisabledModels = Record<AgentProviderId, string[]>

export const DEFAULT_PROVIDER_ENABLED: ProviderEnabled = {
  claude: true,
  codex: true,
  cursor: true,
  copilot: true,
  ollama: true
}

export const DEFAULT_DISABLED_MODELS: DisabledModels = {
  claude: [],
  codex: [],
  cursor: [],
  copilot: [],
  ollama: []
}

export function normalizeProviderEnabled(value: unknown): ProviderEnabled {
  const enabled: ProviderEnabled = { ...DEFAULT_PROVIDER_ENABLED }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return enabled
  const candidate = value as Record<string, unknown>
  for (const provider of AGENT_PROVIDER_IDS) {
    if (typeof candidate[provider] === 'boolean') enabled[provider] = candidate[provider]
  }
  return enabled
}

export function parseProviderEnabled(value: unknown): ProviderEnabled {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Provider-Schalter muessen als Objekt angegeben werden.')
  }
  for (const [provider, enabled] of Object.entries(value as Record<string, unknown>)) {
    if (!AGENT_PROVIDER_IDS.includes(provider as AgentProviderId) || typeof enabled !== 'boolean') {
      throw new Error(`Ungueltiger Provider-Schalter: ${provider}`)
    }
  }
  return normalizeProviderEnabled(value)
}

export function normalizeDisabledModels(value: unknown): DisabledModels {
  const disabled: DisabledModels = {
    claude: [],
    codex: [],
    cursor: [],
    copilot: [],
    ollama: []
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return disabled
  const candidate = value as Record<string, unknown>
  for (const provider of AGENT_PROVIDER_IDS) {
    const models = candidate[provider]
    if (!Array.isArray(models)) continue
    disabled[provider] = [...new Set(models
      .filter((model): model is string => typeof model === 'string' && Boolean(model.trim()))
      .map((model) => model.trim()))]
  }
  return disabled
}

export function parseDisabledModels(value: unknown): DisabledModels {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Deaktivierte Modelle muessen als Objekt angegeben werden.')
  }
  for (const [provider, models] of Object.entries(value as Record<string, unknown>)) {
    if (
      !AGENT_PROVIDER_IDS.includes(provider as AgentProviderId) ||
      !Array.isArray(models) ||
      models.some((model) => typeof model !== 'string')
    ) {
      throw new Error(`Ungueltige Modell-Deaktivierung: ${provider}`)
    }
  }
  return normalizeDisabledModels(value)
}

export function isModelDisabled(
  disabledModels: DisabledModels,
  provider: AgentProviderId,
  model: string
): boolean {
  const normalized = model.trim().toLowerCase()
  return Boolean(
    normalized &&
    disabledModels[provider].some((entry) => entry.toLowerCase() === normalized)
  )
}
