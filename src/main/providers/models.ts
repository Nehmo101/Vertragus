/**
 * Account-aware model discovery for provider pickers.
 *
 * A live catalogue is never merged with curated defaults: once a CLI or its
 * account-scoped cache returns models, only those identifiers are exposed.
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

function unavailable(detail: string): ProviderModelCatalogEntry {
  return { models: [], source: 'unavailable', accountDependent: true, detail }
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

/** Parse Claude Code's local account option cache without trusting configured defaults. */
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
      if (typeof option.label === 'string' && /^fable$/i.test(option.label.trim())) models.push('fable')
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

async function codexCatalog(deps: ModelDiscoveryDependencies): Promise<ProviderModelCatalogEntry> {
  const root = join(deps.homeDir(), '.codex')
  try {
    const live = parseCodexModelCache(deps.readFile(join(root, 'models_cache.json')))
    if (live.length > 0) {
      return {
        models: live,
        source: 'live',
        accountDependent: true,
        detail: 'Account-Katalog aus dem lokalen Codex-CLI-Cache.'
      }
    }
  } catch {
    // Cache unavailable — fall through to an explicitly labelled fallback.
  }

  let configured: string | undefined
  try {
    configured = configuredTomlModel(deps.readFile(join(root, 'config.toml')))
  } catch {
    // Optional configured default.
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
      : unavailable('cursor-agent hat keine Modelle für dieses Konto gemeldet.')
  } catch {
    return unavailable('cursor-agent models ist nicht verfügbar oder nicht angemeldet.')
  }
}

async function claudeCatalog(deps: ModelDiscoveryDependencies): Promise<ProviderModelCatalogEntry> {
  try {
    const live = parseClaudeAccountCache(deps.readFile(join(deps.homeDir(), '.claude.json')))
    if (live.length > 0) {
      return {
        models: live,
        source: 'live',
        accountDependent: true,
        detail: 'Account-Katalog aus dem lokalen Claude-Code-Cache.'
      }
    }
  } catch {
    // Account cache unavailable — configured defaults are not entitlement proof.
  }

  return unavailable(
    'Claude-Account-Katalog nicht verfügbar; konfigurierte Defaults sind kein Berechtigungsnachweis.'
  )
}

async function copilotCatalog(deps: ModelDiscoveryDependencies): Promise<ProviderModelCatalogEntry> {
  try {
    const help = await deps.exec('copilot', ['--help'], 5_000)
    if (/^\s*models?\s+/im.test(help)) {
      const live = parseSimpleModelList(await deps.exec('copilot', ['models'], 8_000))
      if (live.length > 0) {
        return {
          models: live,
          source: 'live',
          accountDependent: true,
          detail: 'Live von der Copilot-CLI.'
        }
      }
    }
  } catch {
    // CLI missing, unauthenticated, or no supported model-list command.
  }
  return fallback('copilot', DEFAULT_MODELS.copilot, 'Copilot-Modellliste nicht verifizierbar.')
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
