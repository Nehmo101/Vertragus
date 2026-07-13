/**
 * Account-aware model discovery for provider pickers.
 *
 * Discovery is provider-specific: complete account/local catalogues replace
 * fallbacks (Codex, Cursor, Ollama), while Claude's partial option cache is
 * merged with its stable CLI aliases and curated suggestions.
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

const execFileAsync = promisify(execFile)
const ANSI_SGR_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

export interface ModelDiscoveryDependencies {
  exec(command: string, args: string[], timeoutMs: number): Promise<string>
  readFile(path: string): string
  homeDir(): string
  fetchJson(url: string, timeoutMs: number): Promise<unknown>
}

const defaultDependencies: ModelDiscoveryDependencies = {
  async exec(command, args, timeoutMs) {
    const { stdout } = await execFileAsync(command, args, {
      timeout: timeoutMs,
      windowsHide: true,
      // Windows provider CLIs are commonly installed as PowerShell/cmd shims.
      shell: process.platform === 'win32'
    })
    return stdout
  },
  readFile: (path) => readFileSync(path, 'utf8'),
  homeDir: homedir,
  async fetchJson(url, timeoutMs) {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return response.json()
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

/** Conservative parser for CLIs that print one model identifier per line. */
export function parseSimpleModelList(stdout: string): string[] {
  return uniqueModels(
    stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^[a-z0-9][a-z0-9._:/-]*$/i.test(line))
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

async function claudeCatalog(deps: ModelDiscoveryDependencies): Promise<ProviderModelCatalogEntry> {
  try {
    const live = parseClaudeAccountCache(deps.readFile(join(deps.homeDir(), '.claude.json')))
    if (live.length > 0) {
      return {
        models: mergeModels(DEFAULT_MODELS.claude, live),
        source: 'mixed',
        accountDependent: true,
        detail: 'Claude-CLI-Aliase und Vorschläge plus lokale zusätzliche Account-Optionen.'
      }
    }
  } catch {
    // Account cache unavailable — configured defaults are not entitlement proof.
  }

  return fallback(
    'claude',
    DEFAULT_MODELS.claude,
    'Stabile Claude-CLI-Aliase und kuratierte Modellvorschläge.'
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

export async function listModels(
  overrides: Partial<ModelDiscoveryDependencies> = {}
): Promise<ProviderModelCatalog> {
  const deps = { ...defaultDependencies, ...overrides }
  const [claude, codex, cursor, copilot, ollama] = await Promise.all([
    claudeCatalog(deps),
    codexCatalog(deps),
    cursorCatalog(deps),
    copilotCatalog(deps),
    ollamaCatalog(deps)
  ])
  return { claude, codex, cursor, copilot, ollama }
}
