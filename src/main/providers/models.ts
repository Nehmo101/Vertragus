/**
 * Account-aware model discovery for provider pickers.
 *
 * Discovery is provider-specific: complete account/local catalogues replace
 * fallbacks (Codex, Cursor, Ollama), while Claude's partial option cache is
 * merged with the provider's live model endpoint, its stable CLI aliases and
 * curated suggestions.
 *
 * Freshness has three layers, so nobody has to hand-edit a list when a provider
 * ships a new model:
 * 1. Live sources first — account caches, CLI output, and (for Claude, when a
 *    key is present) the Anthropic Models API, which knows models released
 *    after this build.
 * 2. Derived rolling aliases — every Claude family found live also gets its bare
 *    alias (`opus`, `sonnet`, …), which the CLI resolves to that family's newest
 *    release. A profile pinned to an alias upgrades itself.
 * 3. A remembered catalogue — ids seen in earlier refreshes survive a partial or
 *    failed discovery instead of disappearing from the picker, and age out after
 *    MEMORY_TTL_MS. DEFAULT_MODELS is only the cold-start seed underneath all of
 *    that.
 */
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  DEFAULT_MODELS,
  type AgentProviderId,
  type ProviderModelCatalog,
  type ProviderModelCatalogEntry
} from '@shared/providers'
import { modelFamily, orderedModelList } from '@shared/models'
import { resolveLaunch } from '@main/agents/resolveCommand'

const execFileAsync = promisify(execFile)
const ANSI_SGR_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

/** Settings key holding the remembered per-provider catalogue. */
export const MODEL_MEMORY_SETTING = 'modelCatalogMemory'
/** Remembered ids not seen again within 60 days are forgotten. */
export const MEMORY_TTL_MS = 60 * 24 * 60 * 60 * 1_000
/** Local models are physically present or not — remembering them would lie. */
const MEMORY_PROVIDERS: readonly AgentProviderId[] = [
  'claude',
  'kimi',
  'codex',
  'cursor',
  'copilot'
]

/** `{ provider: { modelId: lastSeenAtMs } }` */
export type ModelCatalogMemory = Partial<Record<AgentProviderId, Record<string, number>>>

export interface ModelDiscoveryDependencies {
  exec(command: string, args: string[], timeoutMs: number): Promise<string>
  readFile(path: string): string
  homeDir(): string
  fetchJson(
    url: string,
    timeoutMs: number,
    headers?: Record<string, string>
  ): Promise<unknown>
  env(name: string): string | undefined
  now(): number
  readMemory(): Promise<unknown> | unknown
  writeMemory(memory: ModelCatalogMemory): Promise<void> | void
}

const defaultDependencies: ModelDiscoveryDependencies = {
  async exec(command, args, timeoutMs) {
    // Windows provider CLIs are commonly installed as PowerShell/cmd shims that
    // execFile cannot start directly; resolveLaunch rewrites them to an explicit
    // interpreter + script path instead of enabling shell interpretation.
    const launch =
      process.platform === 'win32' ? await resolveLaunch(command, args) : { file: command, args }
    const { stdout } = await execFileAsync(launch.file, launch.args, {
      timeout: timeoutMs,
      windowsHide: true
    })
    return stdout
  },
  readFile: (path) => readFileSync(path, 'utf8'),
  homeDir: homedir,
  async fetchJson(url, timeoutMs, headers) {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return response.json()
  },
  env: (name) => process.env[name],
  now: () => Date.now(),
  async readMemory() {
    // Imported lazily: the config store pulls in electron, and discovery must
    // stay importable (and testable) without an Electron runtime.
    try {
      const { getSetting } = await import('@main/config/store')
      return getSetting(MODEL_MEMORY_SETTING)
    } catch {
      return undefined
    }
  },
  async writeMemory(memory) {
    try {
      const { setSetting } = await import('@main/config/store')
      setSetting(MODEL_MEMORY_SETTING, memory)
    } catch {
      // A read-only or unavailable store must never fail a refresh.
    }
  }
}

function uniqueModels(values: unknown[]): string[] {
  const seen = new Set<string>()
  for (const value of values) {
    if (typeof value !== 'string') continue
    const model = value.trim()
    if (model) seen.add(model)
  }
  return [...seen]
}

function mergeModels(...groups: unknown[][]): string[] {
  return uniqueModels(groups.flat())
}

function fallback(
  provider: AgentProviderId,
  models: string[] = DEFAULT_MODELS[provider],
  detail = 'Kuratierte Vorschläge; Konto-Verfügbarkeit nicht verifiziert.'
): ProviderModelCatalogEntry {
  return {
    models: uniqueModels(models),
    source: 'fallback',
    accountDependent: provider !== 'ollama',
    detail
  }
}

/** Parse the account-scoped cache written by the Codex CLI. */
export function parseCodexModelCache(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as { models?: unknown }
    if (!Array.isArray(parsed.models)) return []
    return uniqueModels(
      parsed.models
        .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
        .filter((entry) => entry.visibility !== 'hide')
        .map((entry) => entry.slug)
    )
  } catch {
    return []
  }
}

/** Parse Claude Code's partial local cache of additional account options. */
export function parseClaudeAccountCache(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as {
      additionalModelOptionsCache?: unknown
      modelAccessCache?: unknown
    }
    const candidates: unknown[] = []
    const additional = parsed.additionalModelOptionsCache
    if (Array.isArray(additional)) {
      candidates.push(...additional)
    } else if (additional && typeof additional === 'object') {
      const record = additional as Record<string, unknown>
      if ('value' in record) candidates.push(record)
      else candidates.push(...Object.values(record))
    }
    if (Array.isArray(parsed.modelAccessCache)) candidates.push(...parsed.modelAccessCache)

    const models: string[] = []
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== 'object') continue
      const option = candidate as { value?: unknown; label?: unknown; model?: unknown }
      const rawValue = typeof option.value === 'string' ? option.value : option.model
      if (typeof rawValue !== 'string') continue
      const value = rawValue
        .replace(ANSI_SGR_PATTERN, '')
        .replace(/\[[0-9;]*m\]$/g, '')
        .trim()
      if (!value) continue
      models.push(value)
      if (typeof option.label === 'string') {
        const alias = option.label.trim().toLowerCase()
        if (alias === 'sonnet' || alias === 'opus' || alias === 'haiku' || alias === 'fable') {
          models.push(alias)
        }
      }
    }
    return uniqueModels(models)
  } catch {
    return []
  }
}

function configuredTomlModel(raw: string): string | undefined {
  return raw.match(/^\s*model\s*=\s*"([^"]+)"/m)?.[1]?.trim() || undefined
}

/** Parse `cursor-agent models`; only the CLI-returned identifiers survive. */
export function parseCursorModels(stdout: string): string[] {
  return uniqueModels(
    stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !/^available models:?$/i.test(line))
      .map((line) => line.replace(/^[*\-\s]+/, '').split(/\s+-\s+/)[0]?.trim())
      .filter((line) => Boolean(line) && /^[a-z0-9][a-z0-9._:/-]*$/i.test(line!))
  )
}

/** Parse model identifiers advertised in the installed Copilot CLI help. */
export function parseCopilotHelpModels(stdout: string): string[] {
  const plain = stdout.replace(ANSI_SGR_PATTERN, '')
  const identifiers = plain.match(
    /\b(?:auto|claude-[a-z0-9][a-z0-9.-]*|gpt-[a-z0-9][a-z0-9.-]*|gemini-[a-z0-9][a-z0-9.-]*|mai-[a-z0-9][a-z0-9.-]*)\b/gi
  )
  return uniqueModels((identifiers ?? []).map((model) => model.toLowerCase()))
}

function configuredJsonModel(raw: string): string | undefined {
  try {
    const model = (JSON.parse(raw) as { model?: unknown }).model
    return typeof model === 'string' ? model.trim() || undefined : undefined
  } catch {
    return undefined
  }
}

async function codexCatalog(deps: ModelDiscoveryDependencies): Promise<ProviderModelCatalogEntry> {
  const root = join(deps.homeDir(), '.codex')
  let configured: string | undefined
  try {
    configured = configuredTomlModel(deps.readFile(join(root, 'config.toml')))
  } catch {
    // Optional configured default.
  }

  try {
    const live = parseCodexModelCache(deps.readFile(join(root, 'models_cache.json')))
    if (live.length > 0) {
      return {
        models: mergeModels(configured ? [configured] : [], live),
        source: 'live',
        accountDependent: true,
        detail: 'Vollständiger Account-Katalog aus dem lokalen Codex-CLI-Cache.'
      }
    }
  } catch {
    // Cache unavailable — fall through to an explicitly labelled fallback.
  }

  return fallback(
    'codex',
    configured ? [configured, ...DEFAULT_MODELS.codex] : DEFAULT_MODELS.codex,
    'Codex-Katalog nicht verfügbar; Konfiguration und kuratierte Vorschläge.'
  )
}

async function cursorCatalog(deps: ModelDiscoveryDependencies): Promise<ProviderModelCatalogEntry> {
  try {
    const live = parseCursorModels(await deps.exec('cursor-agent', ['models'], 8_000))
    return live.length > 0
      ? {
          models: live,
          source: 'live',
          accountDependent: true,
          detail: 'Live von cursor-agent models.'
        }
      : fallback('cursor', DEFAULT_MODELS.cursor, 'cursor-agent hat keine Modelle gemeldet.')
  } catch {
    return fallback(
      'cursor',
      DEFAULT_MODELS.cursor,
      'cursor-agent models ist nicht verfügbar; kuratierte Vorschläge.'
    )
  }
}

/** Model ids from the Anthropic Models API response envelope. */
export function parseAnthropicModelList(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return []
  const data = (payload as { data?: unknown }).data
  if (!Array.isArray(data)) return []
  return uniqueModels(
    data.map((entry) =>
      entry && typeof entry === 'object' ? (entry as { id?: unknown }).id : undefined
    )
  )
}

/**
 * Rolling `--model` aliases for every Claude family in a catalogue.
 *
 * Claude Code documents an alias as "the latest model of that family", so this
 * is what makes a new release usable without a Vertragus update: the moment
 * `claude-<family>-<version>` shows up live, `<family>` is offered too.
 */
export function claudeFamilyAliases(models: readonly string[]): string[] {
  return uniqueModels(
    models
      .filter((model) => model.toLowerCase().startsWith('claude-'))
      .map((model) => modelFamily(model))
      .filter((family) => family.length > 0 && !family.includes('-'))
  )
}

/**
 * Anthropic's own model list — the only source that knows models released after
 * this build. Used when a key is present (API-key users and `ANTHROPIC_AUTH_TOKEN`
 * sessions); subscription-only installs simply skip it and keep the local
 * account cache as their live source.
 */
async function anthropicApiModels(deps: ModelDiscoveryDependencies): Promise<string[]> {
  const apiKey = deps.env('ANTHROPIC_API_KEY')?.trim()
  const authToken = deps.env('ANTHROPIC_AUTH_TOKEN')?.trim()
  if (!apiKey && !authToken) return []
  const base = (deps.env('ANTHROPIC_BASE_URL')?.trim() || 'https://api.anthropic.com').replace(
    /\/+$/,
    ''
  )
  const headers: Record<string, string> = { 'anthropic-version': '2023-06-01' }
  if (apiKey) headers['x-api-key'] = apiKey
  else {
    headers.Authorization = `Bearer ${authToken}`
    // OAuth tokens are only accepted on the bearer path with this beta header.
    headers['anthropic-beta'] = 'oauth-2025-04-20'
  }
  try {
    return parseAnthropicModelList(await deps.fetchJson(`${base}/v1/models?limit=100`, 6_000, headers))
  } catch {
    // No key permission, offline, or a gateway that does not expose /v1/models.
    return []
  }
}

async function claudeCatalog(deps: ModelDiscoveryDependencies): Promise<ProviderModelCatalogEntry> {
  const apiModels = await anthropicApiModels(deps)
  let accountModels: string[] = []
  try {
    accountModels = parseClaudeAccountCache(deps.readFile(join(deps.homeDir(), '.claude.json')))
  } catch {
    // Account cache unavailable — configured defaults are not entitlement proof.
  }

  const live = mergeModels(apiModels, accountModels)
  if (live.length > 0) {
    // Aliases first: they are the entries that keep tracking new releases.
    const aliases = claudeFamilyAliases(mergeModels(live, DEFAULT_MODELS.claude))
    return {
      models: mergeModels(aliases, live, DEFAULT_MODELS.claude),
      source: apiModels.length > 0 ? 'live' : 'mixed',
      accountDependent: true,
      detail:
        apiModels.length > 0
          ? 'Live aus der Anthropic-Modell-API plus Aliase für die jeweils neueste Version.'
          : 'Claude-CLI-Aliase und Vorschläge plus lokale zusätzliche Account-Optionen.'
    }
  }

  return fallback(
    'claude',
    DEFAULT_MODELS.claude,
    'Stabile Claude-CLI-Aliase und kuratierte Modellvorschläge.'
  )
}

async function kimiCatalog(): Promise<ProviderModelCatalogEntry> {
  // Kimi Code CLI exposes no documented machine-readable model list, so — like
  // Copilot — we surface curated K3/K2 suggestions instead of probing a
  // nonexistent subcommand. Swap in live discovery once the CLI offers one.
  return fallback(
    'kimi',
    DEFAULT_MODELS.kimi,
    'Kuratierte Kimi-K3/K2-Vorschläge; Konto-Verfügbarkeit nicht verifiziert.'
  )
}

async function copilotCatalog(deps: ModelDiscoveryDependencies): Promise<ProviderModelCatalogEntry> {
  const root = join(deps.homeDir(), '.copilot')
  let configured: string | undefined
  try {
    configured = configuredJsonModel(deps.readFile(join(root, 'settings.json')))
  } catch {
    // Optional configured default.
  }
  try {
    const live = parseCopilotHelpModels(await deps.exec('copilot', ['help'], 5_000))
    if (live.length > 0) {
      return {
        models: mergeModels(configured ? [configured] : [], live),
        source: 'live',
        accountDependent: true,
        detail: 'Von der installierten Copilot-CLI gemeldete Modelle; Kontorichtlinien gelten.'
      }
    }
  } catch {
    // CLI missing or unable to print help.
  }
  return fallback(
    'copilot',
    mergeModels(configured ? [configured] : [], DEFAULT_MODELS.copilot),
    'Copilot-CLI-Modellliste nicht verfügbar; dokumentierte Vorschläge.'
  )
}

async function ollamaCatalog(deps: ModelDiscoveryDependencies): Promise<ProviderModelCatalogEntry> {
  try {
    const data = (await deps.fetchJson('http://localhost:11434/api/tags', 3_000)) as {
      models?: Array<{ name?: unknown }>
    }
    const live = uniqueModels((data.models ?? []).map((model) => model.name))
    if (live.length > 0) {
      return {
        models: live,
        source: 'live',
        accountDependent: false,
        detail: 'Live vom lokalen Ollama-Dienst.'
      }
    }
  } catch {
    // Local daemon offline — keep a labelled fallback.
  }
  return fallback('ollama', DEFAULT_MODELS.ollama, 'Lokaler Ollama-Dienst nicht erreichbar.')
}

/** Validate the persisted memory; a corrupt value degrades to "nothing known". */
export function normalizeModelMemory(value: unknown): ModelCatalogMemory {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const memory: ModelCatalogMemory = {}
  for (const provider of MEMORY_PROVIDERS) {
    const entry = (value as Record<string, unknown>)[provider]
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const seen: Record<string, number> = {}
    for (const [model, at] of Object.entries(entry as Record<string, unknown>)) {
      const id = model.trim()
      if (id && typeof at === 'number' && Number.isFinite(at)) seen[id] = at
    }
    if (Object.keys(seen).length > 0) memory[provider] = seen
  }
  return memory
}

/**
 * Fold the remembered catalogue into a freshly discovered one.
 *
 * Provider caches are partial and CLIs go missing, so a refresh that finds less
 * than the last one must not shrink the picker. Currently discovered ids refresh
 * their timestamp; remembered-only ids are appended until they age out. A
 * provider whose live discovery returned nothing is served from memory and
 * labelled as such instead of showing an empty list.
 */
export function applyModelMemory(
  provider: AgentProviderId,
  entry: ProviderModelCatalogEntry,
  memory: ModelCatalogMemory,
  now: number
): { entry: ProviderModelCatalogEntry; seen: Record<string, number> } {
  const discovered = entry.models
  if (!MEMORY_PROVIDERS.includes(provider)) {
    return { entry: { ...entry, models: orderedModelList(discovered), refreshedAt: now }, seen: {} }
  }

  const remembered = memory[provider] ?? {}
  const seen: Record<string, number> = {}
  for (const [model, at] of Object.entries(remembered)) {
    if (now - at <= MEMORY_TTL_MS) seen[model] = at
  }
  for (const model of discovered) seen[model] = now

  const discoveredKeys = new Set(discovered.map((model) => model.toLowerCase()))
  const revived = Object.keys(seen).filter((model) => !discoveredKeys.has(model.toLowerCase()))
  const models = orderedModelList([...discovered, ...revived])

  if (discovered.length === 0) {
    return {
      entry: {
        models,
        source: models.length > 0 ? 'fallback' : 'unavailable',
        accountDependent: entry.accountDependent,
        detail:
          models.length > 0
            ? 'Discovery lieferte nichts — zuletzt gesehene Modelle dieses Providers.'
            : entry.detail,
        refreshedAt: now
      },
      seen
    }
  }

  return {
    entry: {
      ...entry,
      models,
      detail:
        revived.length > 0
          ? `${entry.detail ?? ''}${entry.detail ? ' ' : ''}Ergänzt um ${revived.length} zuletzt gesehene Modelle.`
          : entry.detail,
      refreshedAt: now
    },
    seen
  }
}

export async function listModels(
  overrides: Partial<ModelDiscoveryDependencies> = {}
): Promise<ProviderModelCatalog> {
  const deps = { ...defaultDependencies, ...overrides }
  const [claude, kimi, codex, cursor, copilot, ollama] = await Promise.all([
    claudeCatalog(deps),
    kimiCatalog(),
    codexCatalog(deps),
    cursorCatalog(deps),
    copilotCatalog(deps),
    ollamaCatalog(deps)
  ])

  const discovered: ProviderModelCatalog = { claude, kimi, codex, cursor, copilot, ollama }
  const now = deps.now()
  const memory = normalizeModelMemory(await deps.readMemory())
  const catalog = {} as ProviderModelCatalog
  const nextMemory: ModelCatalogMemory = {}
  for (const provider of Object.keys(discovered) as AgentProviderId[]) {
    const merged = applyModelMemory(provider, discovered[provider], memory, now)
    catalog[provider] = merged.entry
    if (Object.keys(merged.seen).length > 0) nextMemory[provider] = merged.seen
  }
  await deps.writeMemory(nextMemory)
  return catalog
}
