/**
 * Cursor Agent "Run Everything" for every native Cursor launch.
 *
 * `--yolo` is only an alias of `--force`. Cursor 3.6+ defaults to Auto-review
 * (sandbox + classifier), so `--yolo` alone still stops on tool calls that
 * cannot run inside the sandbox. Run Everything is `--force` with the
 * sandbox off — the CLI's `/auto-run` toggle, documented as
 * `approvalMode: "unrestricted"` in `cli-config.json`.
 *
 * Argv is the session override. The project `.cursor/cli.json` is the same
 * belt as `mcp-approvals.json`: some TUI builds still read the persisted
 * mode and ignore `--force`. Applied to orchestrator, lead, and worker —
 * Auto-review otherwise still blocks MCP initialize. Fail-soft: a cwd we
 * cannot write does not block spawn.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CURSOR_PROJECT_DIR } from '@main/mcp/attach'
import type { ProviderConfig } from '@shared/schema/provider'

/** Canonical force flag (`--yolo` is the documented alias). */
export const CURSOR_FORCE_FLAG = '--force'
export const CURSOR_YOLO_ALIAS = '--yolo'
export const CURSOR_FORCE_SHORT = '-f'
export const CURSOR_SANDBOX_FLAG = '--sandbox'
export const CURSOR_SANDBOX_DISABLED = 'disabled'
export const CURSOR_CLI_FILE = 'cli.json'
export const CURSOR_APPROVAL_UNRESTRICTED = 'unrestricted'

/** Preset `yoloArgs` and the spawn-side ensure share this exact vector. */
export const CURSOR_RUN_EVERYTHING_ARGS: readonly string[] = [
  CURSOR_FORCE_FLAG,
  CURSOR_SANDBOX_FLAG,
  CURSOR_SANDBOX_DISABLED
]

export interface CursorRunModeDeps {
  readFile?: (path: string) => string
  writeFile?: (path: string, contents: string) => void
  makeDir?: (path: string) => void
  warn?: (message: string, detail?: unknown) => void
}

export type CursorRunModeOutcome = 'written' | 'already-set' | 'skipped'

export interface CursorRunModeResult {
  outcome: CursorRunModeOutcome
  path?: string
  reason?: string
}

function isCursorAgentCommand(command: string | undefined): boolean {
  if (!command) return false
  const base = command.replace(/^.*[/\\]/, '').toLowerCase()
  return /^cursor-agent(\.(exe|cmd|ps1|bat))?$/.test(base)
}

export function cursorUsesProjectDialect(
  provider: Pick<ProviderConfig, 'presetId' | 'mcp'> & Partial<Pick<ProviderConfig, 'command'>>
): boolean {
  return (
    provider.presetId === 'cursor' ||
    provider.mcp.kind === 'cursor-project' ||
    isCursorAgentCommand(provider.command)
  )
}

export function argvHasCursorForce(argv: readonly string[]): boolean {
  return (
    argv.includes(CURSOR_FORCE_FLAG) ||
    argv.includes(CURSOR_YOLO_ALIAS) ||
    argv.includes(CURSOR_FORCE_SHORT)
  )
}

/**
 * Ensure argv is Cursor Run Everything. Mutates and returns `argv`.
 * Leaves an existing `--yolo` in place (alias of `--force`).
 */
export function applyCursorRunEverything(argv: string[]): string[] {
  if (!argvHasCursorForce(argv)) argv.push(CURSOR_FORCE_FLAG)
  const sandboxAt = argv.indexOf(CURSOR_SANDBOX_FLAG)
  if (sandboxAt === -1) {
    argv.push(CURSOR_SANDBOX_FLAG, CURSOR_SANDBOX_DISABLED)
    return argv
  }
  if (argv[sandboxAt + 1] !== CURSOR_SANDBOX_DISABLED) {
    argv[sandboxAt + 1] = CURSOR_SANDBOX_DISABLED
  }
  return argv
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Merge Run Everything onto an existing project CLI config. Never drops foreign keys. */
export function mergeCursorRunEverythingConfig(
  existing: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  const base: Record<string, unknown> = isPlainObject(existing)
    ? { ...existing }
    : {
        version: 1,
        editor: { vimMode: false },
        permissions: { allow: [], deny: [] }
      }
  if (typeof base.version !== 'number') base.version = 1
  if (!isPlainObject(base.editor)) base.editor = { vimMode: false }
  if (!isPlainObject(base.permissions)) base.permissions = { allow: [], deny: [] }
  const sandbox = isPlainObject(base.sandbox) ? { ...base.sandbox } : {}
  sandbox.mode = CURSOR_SANDBOX_DISABLED
  base.approvalMode = CURSOR_APPROVAL_UNRESTRICTED
  base.sandbox = sandbox
  return base
}

function readExistingConfig(
  path: string,
  readFile: (path: string) => string
): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFile(path))
    return isPlainObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

function alreadyRunEverything(config: Record<string, unknown>): boolean {
  if (config.approvalMode !== CURSOR_APPROVAL_UNRESTRICTED) return false
  return isPlainObject(config.sandbox) && config.sandbox.mode === CURSOR_SANDBOX_DISABLED
}

/**
 * Write `<cwd>/.cursor/cli.json` with `approvalMode: unrestricted` and
 * sandbox disabled. Never throws.
 */
export function ensureCursorRunEverythingConfig(
  workspaceDir: string,
  deps: CursorRunModeDeps = {}
): CursorRunModeResult {
  const warn =
    deps.warn ??
    ((message: string, detail?: unknown): void => {
      console.warn(`[cursor-run-mode] ${message}`, detail ?? '')
    })
  const dir = workspaceDir.trim()
  if (!dir) return { outcome: 'skipped', reason: 'no workspace directory' }

  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, 'utf8'))
  const makeDir = deps.makeDir ?? ((path: string) => mkdirSync(path, { recursive: true }))
  const writeFile =
    deps.writeFile ?? ((path: string, contents: string) => writeFileSync(path, contents))

  const projectDir = join(dir, CURSOR_PROJECT_DIR)
  const filePath = join(projectDir, CURSOR_CLI_FILE)
  const existing = readExistingConfig(filePath, readFile)
  const merged = mergeCursorRunEverythingConfig(existing)
  if (existing && alreadyRunEverything(existing)) {
    return { outcome: 'already-set', path: filePath }
  }
  try {
    makeDir(projectDir)
  } catch (error) {
    warn(`could not create ${projectDir}`, error)
    return { outcome: 'skipped', path: filePath, reason: 'could not create .cursor' }
  }
  try {
    writeFile(filePath, `${JSON.stringify(merged, null, 2)}\n`)
    return { outcome: 'written', path: filePath }
  } catch (error) {
    warn(`could not write ${filePath}`, error)
    return { outcome: 'skipped', path: filePath, reason: 'could not write cli.json' }
  }
}
