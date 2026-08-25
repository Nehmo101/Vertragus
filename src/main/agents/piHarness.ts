/**
 * Pi harness wrap — not a provider preset.
 *
 * When the wrap is on, Vertragus still names the slot Claude / Cursor / Codex
 * (model route and subscription). The process that actually starts is `pi`,
 * with `--provider` mapped from the slot's preset and `--model` from the
 * slot's model. Native CLIs (`claude`, `cursor-agent`, …) are not spawned.
 *
 * MCP still has to attach: Pi has no built-in MCP, so we load the community
 * adapter and write `.pi/mcp.json` in the worktree. The adapter and the CLI
 * are lockfile dependencies; Dependabot is allow-listed for those two names
 * only. Pi's `--tools` allowlist can hide MCP tools, so v1 does not restrict it.
 *
 * Flags come from the published CLI
 * (https://pi.dev/docs/latest/usage): `--no-session`, `--approve`,
 * `--no-extensions`, `-e`, `--provider`, `--model`, `--thinking`,
 * `--append-system-prompt`. Pi has no permission prompts — native yolo
 * flags are not forwarded.
 *
 * Do not `import` the Pi CLI as a JS module — that would pull the agent into
 * the main bundle. Resolution reads `package.json` + `bin.pi` from disk.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EffortLevel } from '@shared/schema/provider'

/**
 * Lockfile package we spawn. Must be the same name `pi-mcp-adapter` imports
 * (`@earendil-works/pi-coding-agent`). The deprecated `@mariozechner/*` 0.73
 * line fails at `-e` load and Pi `process.exit(1)` before `session_start`.
 */
export const PI_CODING_AGENT_PACKAGE = '@earendil-works/pi-coding-agent'

/** Lockfile package loaded as Pi's only extension (`-e`). */
export const PI_MCP_ADAPTER_PACKAGE = 'pi-mcp-adapter'

/**
 * Display name for logs / spawn errors / PATH fallback. The process file is
 * either Electron-as-node running the bundled `bin.pi`, or this name on PATH.
 */
export const PI_HARNESS_COMMAND = 'pi'

interface InstalledPackageJson {
  version?: string
  bin?: string | Record<string, unknown>
}

/**
 * Prefer the asar-unpacked copy when Electron packaged the tree that way.
 * Native addons and WASM next to the CLI cannot load from inside asar.
 */
export function preferAsarUnpacked(filePath: string): string {
  const from = `${sep}app.asar${sep}`
  const index = filePath.indexOf(from)
  if (index === -1) return filePath
  const unpacked =
    filePath.slice(0, index) + `${sep}app.asar.unpacked${sep}` + filePath.slice(index + from.length)
  return existsSync(unpacked) ? unpacked : filePath
}

function packageJsonCandidates(packageName: string): string[] {
  const parts = packageName.split('/')
  const found: string[] = []
  let dir = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    found.push(join(dir, 'node_modules', ...parts, 'package.json'))
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  const resources = process.resourcesPath
  if (typeof resources === 'string' && resources.length > 0) {
    found.push(join(resources, 'app.asar.unpacked', 'node_modules', ...parts, 'package.json'))
    found.push(join(resources, 'app.asar', 'node_modules', ...parts, 'package.json'))
  }
  return found
}

function findInstalledPackageJson(packageName: string): string | undefined {
  for (const candidate of packageJsonCandidates(packageName)) {
    const path = preferAsarUnpacked(candidate)
    if (existsSync(path)) return path
    if (existsSync(candidate)) return preferAsarUnpacked(candidate)
  }
  return undefined
}

function readInstalledPackage(packageName: string): { dir: string; pkg: InstalledPackageJson } | undefined {
  const pkgPath = findInstalledPackageJson(packageName)
  if (!pkgPath) return undefined
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as InstalledPackageJson
    return { dir: dirname(pkgPath), pkg }
  } catch {
    return undefined
  }
}

function binEntry(pkg: InstalledPackageJson, name: string): string | undefined {
  if (typeof pkg.bin === 'string' && pkg.bin.trim()) return pkg.bin.trim()
  if (!pkg.bin || typeof pkg.bin !== 'object') return undefined
  const entry = pkg.bin[name]
  return typeof entry === 'string' && entry.trim() ? entry.trim() : undefined
}

/**
 * Absolute path to the lockfile Pi CLI (`bin.pi` → `dist/cli.js`). Undefined
 * when the package is not installed — callers fall back to PATH `pi`.
 */
export function resolvePiHarnessCli(): string | undefined {
  const installed = readInstalledPackage(PI_CODING_AGENT_PACKAGE)
  if (!installed) return undefined
  const rel = binEntry(installed.pkg, 'pi')
  if (!rel) return undefined
  const cli = preferAsarUnpacked(join(installed.dir, rel))
  return existsSync(cli) ? cli : undefined
}

function adapterVersion(): string | undefined {
  const version = readInstalledPackage(PI_MCP_ADAPTER_PACKAGE)?.pkg.version?.trim()
  return version || undefined
}

const installedAdapterVersion = adapterVersion()

/**
 * Versioned npm specifier derived from the installed adapter. Dependabot
 * bumping the lockfile updates this automatically. Used when the adapter
 * directory is not on disk (PATH-only Pi).
 */
export const PI_MCP_ADAPTER_NPM_SPEC = installedAdapterVersion
  ? `npm:${PI_MCP_ADAPTER_PACKAGE}@${installedAdapterVersion}`
  : `npm:${PI_MCP_ADAPTER_PACKAGE}`

/**
 * What `-e` receives. Prefer the lockfile copy so Play does not npm-install
 * the adapter; fall back to {@link PI_MCP_ADAPTER_NPM_SPEC}.
 */
export function piMcpAdapterExtension(): string {
  const installed = readInstalledPackage(PI_MCP_ADAPTER_PACKAGE)
  if (installed && existsSync(installed.dir)) return installed.dir
  return PI_MCP_ADAPTER_NPM_SPEC
}

/**
 * Community MCP adapter source passed as `-e`. Computed once at load so argv
 * snapshots stay stable for a process. Host discovery of Cursor/Claude
 * project files cannot shadow the per-agent Vertragus URL because
 * `--no-extensions` is set with this as the only extension.
 */
export const PI_MCP_ADAPTER_EXTENSION = piMcpAdapterExtension()

/**
 * Map a Vertragus preset id onto Pi's `--provider`. `undefined` means omit
 * the flag and pass `--model` only (custom slots, Ollama — llama.cpp is not
 * in Pi's published catalogue).
 *
 * Cursor → `github-copilot` is the closest published backend; the Cursor CLI
 * itself is not a Pi provider. Documented, not papered over.
 */
export function piProviderFor(presetId: string | undefined): string | undefined {
  switch (presetId) {
    case 'claude':
      return 'anthropic'
    case 'codex':
      return 'openai-codex'
    case 'kimi':
      return 'kimi-coding'
    case 'cursor':
      return 'github-copilot'
    case 'grok':
      return 'xai'
    default:
      return undefined
  }
}

/**
 * Vertragus effort is `low|medium|high`, which Pi's `--thinking` accepts
 * verbatim. Absent effort → omit the flag (Pi's own default).
 */
export function piThinkingFor(effort: EffortLevel | undefined): string | undefined {
  return effort
}

export interface PiHarnessArgvInput {
  presetId?: string
  model?: string
  effort?: EffortLevel
  systemPrompt?: string
  /**
   * Absolute path passed as `--append-system-prompt`. Pi reads a file when
   * the value exists on disk, so a huge multiline role prompt never sits on
   * argv. Wins over {@link systemPrompt} when both are set.
   */
  appendSystemPromptFile?: string
  initialPrompt?: string
}

/**
 * Pure argv for one Pi wrap. The caller writes `.pi/mcp.json` first; this
 * function never touches the disk and never consults `provider.args` —
 * Ollama's `run --nowordwrap` would break Pi if it leaked through.
 */
export function buildPiHarnessArgv(input: PiHarnessArgvInput): string[] {
  const argv = [
    '--no-session',
    '--approve',
    '--no-extensions',
    '-e',
    PI_MCP_ADAPTER_EXTENSION
  ]
  const provider = piProviderFor(input.presetId)
  if (provider) argv.push('--provider', provider)
  const model = input.model?.trim()
  if (model) argv.push('--model', model)
  const thinking = piThinkingFor(input.effort)
  if (thinking) argv.push('--thinking', thinking)
  const append = input.appendSystemPromptFile?.trim() || input.systemPrompt?.trim()
  if (append) argv.push('--append-system-prompt', append)
  const initial = input.initialPrompt?.trim()
  if (initial) argv.push(initial)
  return argv
}

/** Env overlay so Electron's binary behaves like Node when running the CLI. */
export function piHarnessEnv(cliPath: string | undefined): Record<string, string> | undefined {
  return cliPath ? { ELECTRON_RUN_AS_NODE: '1' } : undefined
}

/**
 * Filename under `<configDir>/vertragus-mcp/`. Electron-as-node leaves
 * `stdin`/`stdout`.isTTY unset even inside a PTY; Pi then picks print mode
 * (`!stdinIsTTY || !stdoutIsTTY`) and one-shots or exits.
 */
export const PI_TTY_PRELOAD_FILE = 'pi-tty-preload.cjs'

/** CJS source loaded with Node `-r` before `dist/cli.js`. Exported for snapshots. */
export const PI_TTY_PRELOAD_SOURCE = `'use strict'
for (const stream of [process.stdin, process.stdout, process.stderr]) {
  if (!stream) continue
  try {
    Object.defineProperty(stream, 'isTTY', { value: true, configurable: true })
  } catch {
    stream.isTTY = true
  }
}
`

/** Write the TTY preload next to Claude's transient MCP configs. */
export function writePiTtyPreload(configDir: string): string {
  const dir = join(configDir, 'vertragus-mcp')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, PI_TTY_PRELOAD_FILE)
  writeFileSync(path, PI_TTY_PRELOAD_SOURCE)
  return path
}
