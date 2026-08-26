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
 *
 * On top of those, a provider may declare `seedModels` — rolling aliases that
 * are ALWAYS offered behind the discovered ids. A discovery source can be
 * perfectly truthful and still far too narrow (see the Claude preset), and a
 * picker with two entries reads as broken. Seeds never name a release, so they
 * are not the hard-coded catalogue this module exists to avoid.
 */
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import { mainMessages } from '@shared/mainMessages'
import { modelFamily, normalizeModelKey, orderedModelList, uniqueModels } from '@shared/models'
import {
  modelMemorySchema,
  uniqueEffortLevels,
  type EffortLevel,
  type ModelDiscovery,
  type ModelMemory,
  type ProviderConfig
} from '@shared/schema/provider'
import { resolveLaunch } from '@main/agents/resolveCommand'
import { refreshProcessPathFromSystem } from '@main/providers/processPath'

const execFileAsync = promisify(execFile)

/** A CLI that has not answered in 8 s is not going to answer usefully. */
export const CLI_DISCOVERY_TIMEOUT_MS = 8_000
/** Localhost services answer in milliseconds or not at all. */
export const HTTP_DISCOVERY_TIMEOUT_MS = 3_000
/** Remembered ids not seen again within 60 days are forgotten. */
export const MEMORY_TTL_MS = 60 * 24 * 60 * 60 * 1_000

/** Built from the escape code itself so the source carries no control char. */
const ANSI_SGR_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

/** First non-empty line of a command's output, trimmed. */
function firstOutputLine(text: string | undefined): string {
  return text?.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? ''
}

/** What Node attaches to an `execFile` rejection beyond the message. */
interface ExecFailure {
  stdout?: string
  stderr?: string
  killed?: boolean
  message?: string
}

/**
 * Turn an `execFile` rejection into ONE line worth showing.
 *
 * Node's own message is `Command failed: cmd.exe /c C:\…\cursor-agent.cmd models`
 * with the CLI's stderr glued behind it — a Windows launch path the user never
 * typed, wrapped around the only sentence that matters. This string ends up
 * under the model picker, so the CLI's own first line wins and the wrapper is
 * dropped. A kill is reported as what it was, because a killed process has no
 * error message of its own.
 */
export function cliFailureMessage(
  cause: unknown,
  timeoutMs: number,
  locale?: string
): string {
  const failure = (cause ?? {}) as ExecFailure
  if (failure.killed) return mainMessages(locale).discoveryTimeout(timeoutMs)
  return (
    firstOutputLine(failure.stderr) ||
    (cause instanceof Error && cause.message.trim() ? cause.message.trim() : String(cause))
  )
}

/** Injection seam for the platform-dependent halves of {@link execProviderCli}. */
export interface ProviderCliRuntime {
  platform: NodeJS.Platform
  exec(file: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }>
  refreshPath(): Promise<void>
}

const runProviderCli: ProviderCliRuntime['exec'] = (file, args, timeoutMs) =>
  execFileAsync(file, args, { timeout: timeoutMs, windowsHide: true })

/** `execFile` reports a command that PATH never resolved as an ENOENT spawn error. */
function isCommandNotFound(cause: unknown): boolean {
  return (cause as { code?: unknown } | null | undefined)?.code === 'ENOENT'
}

/**
 * Run a provider CLI non-interactively.
 *
 * Shared with the health probe on purpose: on Windows most agent CLIs are
 * PowerShell/cmd shims that `execFile` cannot start directly, and `resolveLaunch`
 * rewrites them to an explicit interpreter + script path instead of enabling
 * shell interpretation. Getting that wrong in only one of the two call sites is
 * exactly the kind of drift this codebase is trying to end.
 *
 * `execFile` rejects on ANY non-zero exit, which on its own says nothing about
 * the output: a CLI can print its full catalogue and still exit non-zero over
 * something unrelated (a failed update check, a deprecation guard). Blanking a
 * picker over an exit code alone was never intended, so a completed run's stdout
 * is kept. A KILLED run's is not — its last line is cut mid-token, and a
 * truncated id passes the id whitelist and would be offered as a real model.
 */
export async function execProviderCli(
  command: string,
  args: string[],
  timeoutMs: number,
  locale?: string,
  overrides: Partial<ProviderCliRuntime> = {}
): Promise<string> {
  // Destructured per call, not captured in a module const: `process.platform`
  // is swapped per case by the platform tests here and in the health probe.
  const {
    platform = process.platform,
    exec = runProviderCli,
    refreshPath = refreshProcessPathFromSystem
  } = overrides
  const launch =
    platform === 'win32' ? await resolveLaunch(command, args) : { file: command, args }

  const attempt = async (): Promise<string> => {
    try {
      const { stdout, stderr } = await exec(launch.file, launch.args, timeoutMs)
      return stdout || stderr || ''
    } catch (cause) {
      const failure = (cause ?? {}) as ExecFailure
      if (!failure.killed && failure.stdout?.trim()) return failure.stdout
      throw cause
    }
  }

  try {
    return await attempt()
  } catch (cause) {
    // A macOS app started from Finder/Dock inherits only /usr/bin:/bin:/usr/sbin:
    // /sbin, so a CLI installed under /opt/homebrew or ~/.local/bin is ENOENT
    // although it IS installed — and this function backs the health probe, the
    // auth probe and model discovery alike, so the onboarding card would tell a
    // Claude Code user that no CLI was found. Same retry-on-failure shape as the
    // spawn path in agents/resolveCommand: reading the login shell costs a shell
    // startup, so it happens after a miss and never ahead of every probe. Once
    // only — a refreshed PATH that still misses is the honest answer — and the
    // FIRST error is the one reported, because it is the one the CLI produced.
    if (platform === 'darwin' && isCommandNotFound(cause)) {
      await refreshPath()
      try {
        return await attempt()
      } catch {
        throw new Error(cliFailureMessage(cause, timeoutMs, locale))
      }
    }
    throw new Error(cliFailureMessage(cause, timeoutMs, locale))
  }
}

export interface DiscoveryDependencies {
  exec(command: string, args: string[], timeoutMs: number): Promise<string>
  readFile(path: string): string
  homeDir(): string
  fetchJson(url: string, timeoutMs: number): Promise<unknown>
  now(): number
  readMemory(): unknown | Promise<unknown>
  writeMemory(memory: ModelMemory): void | Promise<void>
  /**
   * Stored UI locale for the user-facing `detail` strings. Optional — absent
   * (tests, headless probes) falls back to the schema default via
   * `mainMessages`. A function, not a value, so appIpc reads the CURRENT
   * setting per discovery instead of freezing boot-time state.
   */
  locale?(): string | undefined
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

/**
 * Where the offered ids came from:
 * - `live` — the provider answered and nothing had to be filled in.
 * - `memory` — the provider said nothing; remembered ids are being served.
 * - `seed` — only the declared rolling aliases; nothing was discovered at all.
 * - `mixed` — discovered/remembered ids PLUS at least one seed.
 * - `none` — nothing to offer; the field is free text only.
 */
export type ModelSource = 'live' | 'memory' | 'seed' | 'mixed' | 'none'

export interface ModelDiscoveryResult {
  models: string[]
  source: ModelSource
  refreshedAt: number
  /**
   * Human-readable reason the live source produced nothing — the command or
   * path that was tried plus the error. The picker shows this instead of
   * leaving the user guessing why their CLI's models are missing.
   */
  detail?: string
  /**
   * Per-model effort rungs from catalogue objects (`supportEfforts`,
   * `reasoning_efforts`, `info.reasoning_efforts`). Absent when nothing was
   * found — the editor then uses the provider fallback, or only Standard.
   */
  efforts?: Record<string, EffortLevel[]>
}

/** Expand a leading `~` to the user's home directory. */
export function expandHome(path: string, home: string): string {
  if (path === '~') return home
  if (path.startsWith('~/') || path.startsWith('~\\')) return home + path.slice(1)
  return path
}

/**
 * Only real ANSI colouring is removed. A trailing bracket suffix is NOT: a
 * genuine SGR sequence is `ESC[1m` and never carries a closing bracket, while
 * `claude-fable-5[1m]` is the CLI's own id for the 1M-context variant. The
 * earlier "looks like leftover ANSI" strip turned exactly that id into a
 * different (smaller-context) model behind the user's back.
 */
function sanitize(value: string): string {
  return value.replace(ANSI_SGR_PATTERN, '').trim()
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
  return parseJsonCatalogue(raw, jsonPath).models
}

/**
 * Well-known effort fields on a catalogue object. String arrays (Kimi
 * `supportEfforts`) and `{value|id|name}` entries (Grok `reasoning_efforts`)
 * both qualify; junk tokens such as `ultra` are dropped.
 */
function parseEffortList(value: unknown): EffortLevel[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const tokens: string[] = []
  for (const item of value) {
    if (typeof item === 'string') {
      tokens.push(item)
      continue
    }
    if (!isRecord(item)) continue
    const key = (['value', 'id', 'name'] as const).find((field) => typeof item[field] === 'string')
    if (key) tokens.push(item[key] as string)
  }
  const levels = uniqueEffortLevels(tokens)
  return levels.length > 0 ? levels : undefined
}

function parseEffortListFromCatalogue(node: Record<string, unknown>): EffortLevel[] | undefined {
  const direct = parseEffortList(node.supportEfforts) ?? parseEffortList(node.reasoning_efforts)
  if (direct) return direct
  if (!isRecord(node.info)) return undefined
  return parseEffortList(node.info.supportEfforts) ?? parseEffortList(node.info.reasoning_efforts)
}

/**
 * Per-model effort rungs from catalogue JSON. Keyed tables use the KEY as the
 * picker id (Kimi `kimi-code/k3`, Grok `grok-4.6`); array entries use an
 * id-bearing field. Never invents ids that `extractModels` would not see.
 */
export function extractModelEfforts(nodes: readonly unknown[]): Record<string, EffortLevel[]> {
  const out: Record<string, EffortLevel[]> = {}

  const assign = (id: string, levels: EffortLevel[]): void => {
    const token = sanitize(id)
    if (!token || levels.length === 0 || token in out) return
    out[token] = levels
  }

  const visit = (node: unknown, depth: number): void => {
    if (depth > 4) return
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1)
      return
    }
    if (!isRecord(node)) return

    const effortsHere = parseEffortListFromCatalogue(node)
    const idKey = ID_KEYS.find((key) => typeof node[key] === 'string')
    if (idKey) {
      if (effortsHere) assign(node[idKey] as string, effortsHere)
      return
    }
    if (effortsHere && isRecord(node.info) && typeof node.info.id === 'string') {
      assign(node.info.id, effortsHere)
      return
    }

    for (const [key, value] of Object.entries(node)) {
      if (!isRecord(value) && !Array.isArray(value)) continue
      const nested = isRecord(value) ? parseEffortListFromCatalogue(value) : undefined
      if (nested) assign(key, nested)
      else visit(value, depth + 1)
    }
  }

  for (const node of nodes) visit(node, 0)
  return out
}

export interface JsonCatalogue {
  models: string[]
  efforts: Record<string, EffortLevel[]>
}

/** Models and well-known effort fields from one JSON document, fail-soft. */
export function parseJsonCatalogue(raw: string, jsonPath: string | undefined): JsonCatalogue {
  try {
    const nodes = collectByPath(JSON.parse(raw), jsonPath)
    return { models: extractModels(nodes), efforts: extractModelEfforts(nodes) }
  } catch {
    return { models: [], efforts: {} }
  }
}

/** First source wins; later ids fill gaps. Dedupes punctuation twins. */
export function mergeModelEfforts(
  base: Record<string, EffortLevel[]>,
  extra: Record<string, EffortLevel[]>
): Record<string, EffortLevel[]> {
  const out: Record<string, EffortLevel[]> = { ...base }
  const known = new Set(Object.keys(out).map((model) => normalizeModelKey(model)))
  for (const [model, list] of Object.entries(extra)) {
    if (list.length === 0) continue
    const key = normalizeModelKey(model)
    if (known.has(key)) continue
    out[model] = list
    known.add(key)
  }
  return out
}

function effortsIfPresent(
  efforts: Record<string, EffortLevel[]>
): { efforts: Record<string, EffortLevel[]> } | Record<string, never> {
  return Object.keys(efforts).length > 0 ? { efforts } : {}
}

/**
 * One model per line, in the `<id> - <Label>` shape `cursor-agent models`
 * prints. Only the id (everything before the first ` - `) is kept; bullets, the
 * "Available models" header, blank lines and the trailing prose tip are
 * dropped because they are not identifiers.
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
): Promise<JsonCatalogue> {
  switch (discovery.kind) {
    case 'none':
      return { models: [], efforts: {} }
    case 'cli': {
      const stdout = await deps.exec(config.command, discovery.args, CLI_DISCOVERY_TIMEOUT_MS)
      return discovery.parse === 'json'
        ? parseJsonCatalogue(stdout, discovery.jsonPath)
        : { models: parseLineModels(stdout), efforts: {} }
    }
    case 'file': {
      const raw = deps.readFile(expandHome(discovery.path, deps.homeDir()))
      return discovery.parse === 'toml-keys'
        ? { models: parseTomlModelKeys(raw), efforts: {} }
        : parseJsonCatalogue(raw, discovery.jsonPath)
    }
    case 'http': {
      const payload = await deps.fetchJson(discovery.url, HTTP_DISCOVERY_TIMEOUT_MS)
      const nodes = collectByPath(payload, discovery.jsonPath)
      return { models: extractModels(nodes), efforts: extractModelEfforts(nodes) }
    }
  }
}

/** Sidecar effort catalogue: fail-soft and never contributes picker ids. */
async function discoverEffortsOnly(
  config: ProviderConfig,
  discovery: ModelDiscovery,
  deps: DiscoveryDependencies
): Promise<Record<string, EffortLevel[]>> {
  try {
    const harvest = await runDiscovery(config, discovery, deps)
    return harvest.efforts
  } catch {
    return {}
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
 * Append the declared seeds behind the ids that were actually found.
 *
 * Discovery hits keep their exact spelling AND their position — a seed only
 * ever fills a gap, it never reorders or replaces what a provider reported.
 * Deduplication runs over {@link normalizeModelKey}, so a seed does not come
 * back as a punctuation twin of something already offered.
 */
export function mergeSeedModels(
  discovered: readonly string[],
  seeds: readonly string[]
): { models: string[]; added: string[] } {
  const known = new Set(discovered.map((model) => normalizeModelKey(model)))
  const added: string[] = []
  for (const seed of uniqueModels(seeds)) {
    const key = normalizeModelKey(seed)
    if (known.has(key)) continue
    known.add(key)
    added.push(seed)
  }
  return { models: [...discovered, ...added], added }
}

/** What was tried, for the "why is this list empty?" hint in the picker. */
function describeSource(config: ProviderConfig, discovery: ModelDiscovery): string {
  switch (discovery.kind) {
    case 'cli':
      return [config.command, ...discovery.args].join(' ')
    case 'file':
      return discovery.path
    case 'http':
      return discovery.url
    case 'none':
      return config.label
  }
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim()) return cause.message.trim()
  return String(cause)
}

/**
 * How the agent CLIs word "you are simply not logged in". Deliberately a
 * phrase list and not an exit-code rule: `cursor-agent status` prints
 * "Not logged in" and exits 0, while `cursor-agent models` exits 1 — the exit
 * code says nothing, the sentence does.
 */
export const AUTH_FAILURE_PATTERN =
  /(authentication|authorization)\s+(required|failed)|not\s+(logged\s*in|signed\s*in|authenticated)|unauthorized|please\s+(log|sign)\s*-?\s*in|no\s+(api[\s-]?key|credentials|token)\s+(found|provided|set)|invalid\s+(api[\s-]?key|token|credentials)|\bHTTP\s*401\b/i

/**
 * Rewrite a discovery failure that is only a missing login into the command
 * that fixes it.
 *
 * "cursor-agent models: Authentication required" is true and still leaves the
 * user guessing, because the CLI names its own binary (`agent login`) and not
 * the one Vertragus launches. The login command is already declared per
 * provider, so the hint is composed from the descriptor rather than typed out
 * per preset. The CLI's own sentence is kept behind it: it is where the
 * alternatives (API key, env var) are spelled out.
 *
 * `locale` picks the language of the hint (the wording lives in
 * `mainMessages`): this string is interpolated into the profile editor's
 * "models from X" sentence, and a German fragment inside an English sentence
 * is exactly the drift WP-1 exists to end.
 */
export function authFailureHint(
  config: ProviderConfig,
  failure: string,
  locale?: string
): string | undefined {
  if (!AUTH_FAILURE_PATTERN.test(failure)) return undefined
  const loginArgs = config.auth?.loginArgs ?? []
  const login = loginArgs.length > 0 ? [config.command, ...loginArgs].join(' ') : undefined
  return mainMessages(locale).authNotLoggedIn(login, failure)
}

/**
 * Discover the model catalogue of one provider. Never throws: a missing CLI,
 * an unreadable cache or an offline service degrades to the remembered list,
 * then to the declared seeds, and from there to an empty list the free-text
 * field still works with. Whatever failed travels along as `detail`.
 */
export async function discoverModels(
  config: ProviderConfig,
  overrides: Partial<DiscoveryDependencies> = {}
): Promise<ModelDiscoveryResult> {
  const deps = { ...defaultDependencies, ...overrides }
  const now = deps.now()
  const discovery = config.modelDiscovery

  let live: string[] = []
  let efforts: Record<string, EffortLevel[]> = {}
  let detail: string | undefined
  try {
    const harvest = await runDiscovery(config, discovery, deps)
    live = harvest.models
    efforts = harvest.efforts
    if (live.length === 0 && discovery.kind !== 'none') {
      detail = `${describeSource(config, discovery)}: ${
        mainMessages(deps.locale?.()).discoveryNoModels
      }`
    }
  } catch (cause) {
    // Fail-soft by design — see the function contract.
    live = []
    const failure = errorMessage(cause)
    detail = `${describeSource(config, discovery)}: ${
      authFailureHint(config, failure, deps.locale?.()) ?? failure
    }`
  }
  const sidecar = config.effortDiscovery
  if (sidecar && sidecar.kind !== 'none') {
    efforts = mergeModelEfforts(efforts, await discoverEffortsOnly(config, sidecar, deps))
  }
  // Aliases first: they are the entries that keep tracking new releases.
  if (config.presetId === 'claude' && live.length > 0) {
    live = uniqueModels([...familyAliases(live), ...live])
  }

  /** Seeds are appended last so a source that answered always wins the order. */
  const finish = (found: readonly string[], base: ModelSource): ModelDiscoveryResult => {
    const { models, added } = mergeSeedModels(found, config.seedModels)
    const source: ModelSource =
      added.length === 0 ? base : base === 'none' ? 'seed' : 'mixed'
    return {
      models,
      source,
      refreshedAt: now,
      ...(detail ? { detail } : {}),
      ...effortsIfPresent(efforts)
    }
  }

  if (!isRememberable(discovery)) {
    const models = orderedModelList(live)
    return finish(models, models.length > 0 ? 'live' : 'none')
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

  // Seeds are deliberately NOT remembered: memory records what a provider was
  // seen to offer, and a seed is a local guarantee, not an observation.
  return finish(models, live.length > 0 ? 'live' : models.length > 0 ? 'memory' : 'none')
}
