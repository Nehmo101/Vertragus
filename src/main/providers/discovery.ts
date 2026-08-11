/**
 * Model discovery — ONE generic runner for the declarative `modelDiscovery`
 * of any provider.
 *
 * The previous generation had a hand-written catalogue function per provider
 * (claudeCatalog, codexCatalog, kimiCatalog, …), which is why every new
 * provider needed core code. Here the provider descriptor says WHERE its models
 * come from (`cli` | `file` | `http` | `none`) and this module executes that
 * declaration. Nothing in Vertragus ships a hard-coded model list.
 *
 * Three properties are deliberately preserved from the old implementation
 * because they are what makes the picker usable:
 * 1. Local-only. No API keys are read and no vendor cloud is queried; only the
 *    installed CLI, its local caches, and localhost services.
 * 2. Rolling family aliases. Every Claude family found live also yields its
 *    bare alias (`claude-opus-5` → `opus`), which the CLI resolves to that
 *    family's newest release — a profile pinned to an alias upgrades itself.
 * 3. A 60-day memory. A refresh that finds less than the last one (cache empty,
 *    CLI missing, offline) must not shrink the picker; remembered ids are
 *    served until they age out.
 */
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import { modelFamily, normalizeModelKey, orderedModelList, uniqueModels } from '@shared/models'
import {
  modelMemorySchema,
  type ModelDiscovery,
  type ModelMemory,
  type ProviderConfig
} from '@shared/schema/provider'
import { resolveLaunch } from '@main/agents/resolveCommand'

const execFileAsync = promisify(execFile)

/** A CLI that has not answered in 8 s is not going to answer usefully. */
export const CLI_DISCOVERY_TIMEOUT_MS = 8_000
/** Localhost services answer in milliseconds or not at all. */
export const HTTP_DISCOVERY_TIMEOUT_MS = 3_000
/** Remembered ids not seen again within 60 days are forgotten. */
export const MEMORY_TTL_MS = 60 * 24 * 60 * 60 * 1_000

/** Built from the escape code itself so the source carries no control char. */
const ANSI_SGR_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

/**
 * Run a provider CLI non-interactively.
 *
 * Shared with the health probe on purpose: on Windows most agent CLIs are
 * PowerShell/cmd shims that `execFile` cannot start directly, and `resolveLaunch`
 * rewrites them to an explicit interpreter + script path instead of enabling
 * shell interpretation. Getting that wrong in only one of the two call sites is
 * exactly the kind of drift this codebase is trying to end.
 */
export async function execProviderCli(
  command: string,
  args: string[],
  timeoutMs: number
): Promise<string> {
  const launch =
    process.platform === 'win32' ? await resolveLaunch(command, args) : { file: command, args }
  const { stdout, stderr } = await execFileAsync(launch.file, launch.args, {
    timeout: timeoutMs,
    windowsHide: true
  })
  return stdout || stderr || ''
}

export interface DiscoveryDependencies {
  exec(command: string, args: string[], timeoutMs: number): Promise<string>
  readFile(path: string): string
  homeDir(): string
  fetchJson(url: string, timeoutMs: number): Promise<unknown>
  now(): number
  readMemory(): unknown | Promise<unknown>
  writeMemory(memory: ModelMemory): void | Promise<void>
}

const defaultDependencies: DiscoveryDependencies = {
  exec: execProviderCli,
  readFile: (path) => readFileSync(path, 'utf8'),
  homeDir: homedir,
  async fetchJson(url, timeoutMs) {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return response.json()
  },
  now: () => Date.now(),
  async readMemory() {
    // Imported lazily: the settings store pulls in Electron, and discovery must
    // stay importable (and testable) without an Electron runtime.
    try {
      const { getSettings } = await import('@main/store/settings')
      return getSettings().modelMemory
    } catch {
      return undefined
    }
  },
  async writeMemory(memory) {
    try {
      const { setSetting } = await import('@main/store/settings')
      setSetting('modelMemory', memory)
    } catch {
      // A read-only or unavailable store must never fail a refresh.
    }
  }
}

export type ModelSource = 'live' | 'memory' | 'none'

export interface ModelDiscoveryResult {
  models: string[]
  /** `live` = the provider answered, `memory` = last-seen ids, `none` = nothing. */
  source: ModelSource
  refreshedAt: number
}

/** Expand a leading `~` to the user's home directory. */
export function expandHome(path: string, home: string): string {
  if (path === '~') return home
  if (path.startsWith('~/') || path.startsWith('~\\')) return home + path.slice(1)
  return path
}

function sanitize(value: string): string {
  return value
    .replace(ANSI_SGR_PATTERN, '')
    .replace(/\[[0-9;]*m\]$/g, '')
    .trim()
}

/** Keys a catalogue entry object may carry the model id under. */
const ID_KEYS = ['value', 'model', 'slug', 'id', 'name'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Walk a tiny JSON path. Segments are dot-separated; a segment ending in `[]`
 * iterates the container it names — arrays by element, objects by VALUE (some
 * CLIs write the same cache as a list in one version and as a keyed table in
 * the next, and a picker must not go blank over that).
 *
 * `models[].name` · `additionalModelOptionsCache[].value` · `models`
 */
export function collectByPath(root: unknown, path: string | undefined): unknown[] {
  let current: unknown[] = [root]
  for (const token of (path ?? '').split('.').filter(Boolean)) {
    const iterate = token.endsWith('[]')
    const key = iterate ? token.slice(0, -2) : token
    const picked: unknown[] = []
    for (const node of current) {
      const value = key ? (isRecord(node) ? node[key] : undefined) : node
      if (value === undefined || value === null) continue
      if (!iterate) {
        picked.push(value)
        continue
      }
      if (Array.isArray(value)) picked.push(...value)
      else if (isRecord(value)) picked.push(...Object.values(value))
    }
    current = picked
  }
  return current
}

/**
 * Coerce whatever a path resolved to into model ids: strings as-is, arrays
 * flattened, catalogue entry objects via their id-bearing field, and a keyed
 * table (`{ "kimi-k3": {...} }`) via its KEYS — which is how Kimi and several
 * config files express a model list.
 */
export function extractModels(nodes: readonly unknown[]): string[] {
  const out: string[] = []
  const visit = (node: unknown, depth: number): void => {
    if (depth > 4) return
    if (typeof node === 'string') {
      out.push(node)
      return
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1)
      return
    }
    if (!isRecord(node)) return
    const idKey = ID_KEYS.find((key) => typeof node[key] === 'string')
    if (idKey) {
      out.push(node[idKey] as string)
      return
    }
    out.push(...Object.keys(node))
  }
  for (const node of nodes) visit(node, 0)
  return uniqueModels(out.map(sanitize))
}

/** `models[].name` over a parsed JSON document, fail-soft. */
export function parseJsonModels(raw: string, jsonPath: string | undefined): string[] {
  try {
    return extractModels(collectByPath(JSON.parse(raw), jsonPath))
  } catch {
    return []
  }
}

/**
 * One model id per line. Strips bullets, drops the "Available models:" style
 * header and anything that is prose rather than an identifier.
 */
export function parseLineModels(stdout: string): string[] {
  return uniqueModels(
    stdout
      .replace(ANSI_SGR_PATTERN, '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !/^available models:?$/i.test(line))
      .map((line) => line.replace(/^[*\-•\s]+/, '').split(/\s+-\s+/)[0]?.trim() ?? '')
      .filter((line) => /^[a-z0-9][a-z0-9._:/-]*$/i.test(line))
  )
}

/**
 * Model aliases from `[models."alias"]` / `[models.alias]` section headers.
 * Deliberately NOT a TOML parser: the only thing a model list needs from these
 * files is the section keys, and a real parser would be a dependency plus a
 * new failure mode for a file we do not own.
 */
export function parseTomlModelKeys(raw: string): string[] {
  const keys: string[] = []
  for (const match of raw.matchAll(/^\s*\[models\.(?:"([^"]+)"|([^\]]+))\]/gm)) {
    const alias = (match[1] ?? match[2])?.trim()
    if (alias) keys.push(alias)
  }
  return uniqueModels(keys)
}

/**
 * Rolling `--model` aliases for every family in a catalogue: the moment
 * `claude-<family>-<version>` appears live, `<family>` is offered too. Only
 * single-word families qualify — a multi-segment "family" is a product name,
 * not an alias the CLI would resolve.
 */
export function familyAliases(models: readonly string[]): string[] {
  return uniqueModels(
    models
      .map((model) => modelFamily(model))
      .filter((family) => family.length > 0 && !family.includes('-'))
  )
}

async function runDiscovery(
  config: ProviderConfig,
  discovery: ModelDiscovery,
  deps: DiscoveryDependencies
): Promise<string[]> {
  switch (discovery.kind) {
    case 'none':
      return []
    case 'cli': {
      const stdout = await deps.exec(config.command, discovery.args, CLI_DISCOVERY_TIMEOUT_MS)
      return discovery.parse === 'json'
        ? parseJsonModels(stdout, discovery.jsonPath)
        : parseLineModels(stdout)
    }
    case 'file': {
      const raw = deps.readFile(expandHome(discovery.path, deps.homeDir()))
      return discovery.parse === 'toml-keys'
        ? parseTomlModelKeys(raw)
        : parseJsonModels(raw, discovery.jsonPath)
    }
    case 'http': {
      const payload = await deps.fetchJson(discovery.url, HTTP_DISCOVERY_TIMEOUT_MS)
      return extractModels(collectByPath(payload, discovery.jsonPath))
    }
  }
}

/** Validate the persisted memory; a corrupt value degrades to "nothing known". */
export function normalizeModelMemory(value: unknown): ModelMemory {
  const parsed = modelMemorySchema.safeParse(value)
  if (!parsed.success) return {}
  const memory: ModelMemory = {}
  for (const [provider, seen] of Object.entries(parsed.data)) {
    const entries = Object.entries(seen).filter(([model]) => model.trim().length > 0)
    if (entries.length > 0) memory[provider] = Object.fromEntries(entries)
  }
  return memory
}

/**
 * Fold the remembered catalogue of ONE provider into a freshly discovered list.
 * Discovered ids refresh their timestamp; remembered-only ids are appended
 * until they age out.
 */
export function applyModelMemory(
  discovered: readonly string[],
  remembered: Record<string, number> | undefined,
  now: number
): { models: string[]; seen: Record<string, number> } {
  const seen: Record<string, number> = {}
  for (const [model, at] of Object.entries(remembered ?? {})) {
    if (now - at <= MEMORY_TTL_MS) seen[model] = at
  }
  for (const model of discovered) seen[model] = now

  // normalizeModelKey, not lowercase: a remembered punctuation twin
  // (`claude-sonnet-4.6` vs `…-4-6`) must age out instead of coming back as
  // "revived" on every single refresh.
  const discoveredKeys = new Set(discovered.map((model) => normalizeModelKey(model)))
  const revived = Object.keys(seen).filter(
    (model) => !discoveredKeys.has(normalizeModelKey(model))
  )
  return { models: orderedModelList([...discovered, ...revived]), seen }
}

/**
 * Memory is a claim about what an account MAY run. For a local service that is
 * a lie: a model deleted from disk cannot run, so http-discovered catalogues
 * (Ollama) are never remembered.
 */
function isRememberable(discovery: ModelDiscovery): boolean {
  return discovery.kind === 'cli' || discovery.kind === 'file'
}

/**
 * Discover the model catalogue of one provider. Never throws: a missing CLI,
 * an unreadable cache or an offline service degrades to the remembered list,
 * and from there to an empty list the free-text field still works with.
 */
export async function discoverModels(
  config: ProviderConfig,
  overrides: Partial<DiscoveryDependencies> = {}
): Promise<ModelDiscoveryResult> {
  const deps = { ...defaultDependencies, ...overrides }
  const now = deps.now()
  const discovery = config.modelDiscovery

  let live: string[] = []
  try {
    live = await runDiscovery(config, discovery, deps)
  } catch {
    // Fail-soft by design — see the function contract.
    live = []
  }
  // Aliases first: they are the entries that keep tracking new releases.
  if (config.presetId === 'claude' && live.length > 0) {
    live = uniqueModels([...familyAliases(live), ...live])
  }

  if (!isRememberable(discovery)) {
    const models = orderedModelList(live)
    return { models, source: models.length > 0 ? 'live' : 'none', refreshedAt: now }
  }

  const memory = normalizeModelMemory(await deps.readMemory())
  const { models, seen } = applyModelMemory(live, memory[config.id], now)
  if (Object.keys(seen).length > 0) {
    const next: ModelMemory = { ...memory, [config.id]: seen }
    try {
      await deps.writeMemory(next)
    } catch {
      // Persisting the memory is best-effort; the result is already computed.
    }
  }

  const source: ModelSource = live.length > 0 ? 'live' : models.length > 0 ? 'memory' : 'none'
  return { models, source, refreshedAt: now }
}
