/**
 * Provider definitions shared across main / preload / renderer.
 * Pure data + types only — no Node.js imports so the renderer can use it too.
 */

export type AgentProviderId = 'claude' | 'codex' | 'cursor' | 'copilot' | 'ollama'
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
 * Model *suggestions* per agent provider — NOT an exhaustive/validated list.
 * The ProfileEditor's model field is free-text; valid models depend on each
 * CLI's version and the user's account. `codex` is intentionally empty here:
 * models.ts prepends the user's ~/.codex/config.toml model, and leaving it blank
 * means "use codex's own configured default" (passing a wrong name 400s, e.g.
 * gpt-5/gpt-5.6 are rejected on a ChatGPT account). Claude aliases are stable.
 */
export const DEFAULT_MODELS: Record<AgentProviderId, string[]> = {
  claude: ['fable', 'opus', 'sonnet', 'haiku'],
  codex: [],
  cursor: ['composer', 'auto'],
  // copilot: free-text like the rest; leaving it blank uses the CLI's own
  // default (currently Claude Sonnet). These are just picker suggestions.
  copilot: ['claude-sonnet-4.5', 'gpt-5'],
  ollama: ['qwen2.5-coder:32b', 'llama3.3:70b', 'deepseek-coder-v2']
}
