import { execFile } from 'node:child_process'
import { access, readFile, symlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { resolveLaunch } from '@main/agents/resolveCommand'

const execFileAsync = promisify(execFile)
/** Per-worktree materialization, deduplicated by the worktree directory. */
const installs = new Map<string, Promise<void>>()
/**
 * One coordinated online warm-up per (repository, lockfile, toolchain, platform),
 * shared by every worktree of that fan-out. Resolves to `true` once the package
 * store is warmed so per-worktree installs can materialize offline, or `false`
 * when no warm-up is applicable/possible so they fall back to a normal install.
 */
const warmups = new Map<string, Promise<boolean>>()

/** Full installs must fit CI-sized repos; pnpm reuses its content store anyway. */
const INSTALL_TIMEOUT_MS = 10 * 60_000

export type DependencyBootstrapStatus =
  | 'not-applicable'
  | 'present'
  | 'linked'
  | 'installed'

export interface DependencyBootstrapResult {
  status: DependencyBootstrapStatus
  toolchain?: string
  detail: string
}

interface InstallCommand {
  command: string
  args: string[]
  label: string
  /** Lockfile whose content fingerprints the coordinated warm-up. */
  lockfile: string
  /**
   * A single coordinated online warm-up (e.g. `pnpm fetch`) that populates the
   * shared package store from the lockfile without linking a node_modules tree.
   */
  warmupArgs?: string[]
  /**
   * Per-worktree materialization to run once the store is warm — prefers the
   * local store/cache so five worktrees do not each re-fetch from the network.
   */
  offlineArgs?: string[]
}

function assertWorktreeContained(repositoryRoot: string, workingDir: string): void {
  const resolvedRoot = resolve(repositoryRoot)
  const resolvedWorkingDir = resolve(workingDir)
  const normalize = (value: string): string => process.platform === 'win32'
    ? value.toLowerCase()
    : value
  const normalizedRoot = normalize(resolvedRoot)
  const normalizedWorkingDir = normalize(resolvedWorkingDir)
  if (normalizedWorkingDir !== normalizedRoot
    && !normalizedWorkingDir.startsWith(`${normalizedRoot}${sep}`)) {
    throw new Error('Ungültiger Dependency-Bootstrap-Pfad außerhalb des Repository-Roots.')
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Lifecycle scripts stay enabled: the quality gates execute repository code
 * (tests, lint) anyway, and skipping postinstall breaks generated toolchains
 * such as prisma clients in freshly bootstrapped worktrees.
 */
async function installCommand(root: string): Promise<InstallCommand | undefined> {
  if (await exists(join(root, 'pnpm-lock.yaml'))) {
    return {
      command: 'corepack',
      args: ['pnpm', 'install', '--frozen-lockfile'],
      label: 'pnpm',
      lockfile: 'pnpm-lock.yaml',
      // pnpm fetch warms the content-addressable store from the lockfile once;
      // --prefer-offline then materializes each worktree from that warm store,
      // still running lifecycle scripts and creating per-worktree .bin links.
      warmupArgs: ['pnpm', 'fetch'],
      offlineArgs: ['pnpm', 'install', '--frozen-lockfile', '--prefer-offline']
    }
  }
  if (await exists(join(root, 'yarn.lock'))) {
    return {
      command: 'corepack',
      args: ['yarn', 'install', '--immutable'],
      label: 'yarn',
      lockfile: 'yarn.lock'
    }
  }
  if (await exists(join(root, 'package-lock.json'))) {
    return { command: 'npm', args: ['ci'], label: 'npm', lockfile: 'package-lock.json' }
  }
  if (await exists(join(root, 'bun.lock')) || await exists(join(root, 'bun.lockb'))) {
    return {
      command: 'bun',
      args: ['install', '--frozen-lockfile'],
      label: 'bun',
      lockfile: (await exists(join(root, 'bun.lock'))) ? 'bun.lock' : 'bun.lockb'
    }
  }
  return undefined
}

async function declaredPackageManager(root: string): Promise<string | undefined> {
  try {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      packageManager?: unknown
    }
    return typeof pkg.packageManager === 'string' ? pkg.packageManager : undefined
  } catch {
    return undefined
  }
}

/** Fingerprint the lockfile content so a dependency change re-runs the warm-up. */
async function lockfileFingerprint(repositoryRoot: string, lockfile: string): Promise<string> {
  try {
    const content = await readFile(join(repositoryRoot, lockfile))
    return createHash('sha256').update(content).digest('hex')
  } catch {
    // No readable lockfile → fingerprint absent; warm-up keys stay per-repo.
    return 'no-lockfile'
  }
}

async function runLaunch(installDir: string, command: string, args: string[]): Promise<void> {
  await resolveLaunch(command, args)
    .then((launch) => execFileAsync(launch.file, launch.args, {
      cwd: installDir,
      windowsHide: true,
      timeout: INSTALL_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024
    }))
    .then(() => undefined)
    .catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        throw new Error(
          `Dependency-Bootstrap (${command}) fehlgeschlagen: '${command}' wurde nicht ` +
          'gefunden. PATH des App-Prozesses prüfen — Versionsmanager wie fnm/nvm verlinken oft nur ' +
          'node; corepack/npm müssen daneben verfügbar sein.'
        )
      }
      throw error
    })
}

/**
 * Coordinate a single online warm-up shared by every worktree of a fan-out.
 * Concurrent callers await the same in-flight promise; a warm-up failure is
 * non-fatal (per-worktree installs simply run online) and is evicted so it never
 * permanently poisons the session cache.
 */
async function ensureStoreWarmup(
  repositoryRoot: string,
  command: InstallCommand
): Promise<boolean> {
  if (!command.warmupArgs || !command.offlineArgs) return false
  const fingerprint = await lockfileFingerprint(repositoryRoot, command.lockfile)
  const key = [
    resolve(repositoryRoot),
    command.label,
    fingerprint,
    process.platform
  ].join('\0')

  let pending = warmups.get(key)
  if (!pending) {
    const warmupArgs = command.warmupArgs
    pending = runLaunch(repositoryRoot, command.command, warmupArgs)
      .then(() => true)
      .catch(() => {
        // Warm-up is an optimization: on failure fall back to a normal install.
        // Evicting lets a later fan-out retry instead of caching the miss.
        warmups.delete(key)
        return false
      })
    warmups.set(key, pending)
  }
  return pending
}

async function installDependencies(installDir: string, command: string, args: string[]): Promise<void> {
  let pending = installs.get(installDir)
  if (!pending) {
    pending = runLaunch(installDir, command, args)
    installs.set(installDir, pending)
    void pending.finally(() => installs.delete(installDir)).catch(() => undefined)
  }
  await pending
}

/**
 * Provide a complete dependency tree for a worktree. A real package-manager
 * install runs directly in the worktree so that monorepo workspace packages
 * get their own node_modules/.bin (eslint) and lifecycle-generated artifacts
 * (prisma client) exist — a top-level symlink to the primary checkout covers
 * neither. The symlink remains only as fallback for unknown toolchains.
 *
 * What runs once vs. per worktree:
 *   - ONCE per (repository, lockfile fingerprint, toolchain, platform): the
 *     online warm-up (`pnpm fetch`) that populates the shared package store.
 *     Five concurrently starting worktrees share this single fetch.
 *   - PER worktree: the store materialization (`pnpm install --prefer-offline`),
 *     which links the worktree-local node_modules/.bin, resolves workspace links
 *     and runs lifecycle scripts. This stays per worktree by design; after the
 *     warm-up it no longer re-fetches from the network.
 */
export async function ensureWorktreeDependencies(
  repositoryRoot: string,
  workingDir: string
): Promise<DependencyBootstrapResult> {
  assertWorktreeContained(repositoryRoot, workingDir)

  if (!await exists(join(repositoryRoot, 'package.json'))) {
    return { status: 'not-applicable', detail: 'Kein Node-Paket im Repository erkannt.' }
  }

  const toolchain = await declaredPackageManager(repositoryRoot)
  const rootModules = join(repositoryRoot, 'node_modules')
  const workerModules = join(workingDir, 'node_modules')
  if (await exists(workerModules)) {
    return { status: 'present', toolchain, detail: 'Dependencies sind im Workspace vorhanden.' }
  }

  const command = await installCommand(
    await exists(join(workingDir, 'package.json')) ? workingDir : repositoryRoot
  )
  if (command) {
    // Single coordinated online fetch shared by all sibling worktrees, then a
    // per-worktree offline materialization instead of N identical network runs.
    const warmed = await ensureStoreWarmup(repositoryRoot, command)
    const installArgs = warmed && command.offlineArgs ? command.offlineArgs : command.args
    await installDependencies(workingDir, command.command, installArgs)
    if (!await exists(workerModules)) {
      throw new Error('Dependency-Bootstrap lief durch, aber node_modules fehlt weiterhin.')
    }
    return {
      status: 'installed',
      toolchain,
      detail: warmed
        ? `Dependencies mit ${command.label} materialisiert (koordinierter Warm-up, offline pro Worktree).`
        : `Dependencies wurden mit ${command.label} direkt im Worktree installiert.`
    }
  }

  if (repositoryRoot === workingDir) {
    throw new Error('Dependencies fehlen und es wurde kein unterstützter Lockfile-Toolchain erkannt.')
  }
  if (!await exists(rootModules)) {
    throw new Error('Dependencies fehlen und es wurde kein unterstützter Lockfile-Toolchain erkannt.')
  }
  await symlink(rootModules, workerModules, process.platform === 'win32' ? 'junction' : 'dir')
  return {
    status: 'linked',
    toolchain,
    detail: 'Worktree verwendet den gemeinsamen Dependency-/Build-Cache (kein Lockfile-Toolchain erkannt).'
  }
}

/** Test seam: reset the process-lifetime coordination caches. */
export function __resetDependencyBootstrapCaches(): void {
  installs.clear()
  warmups.clear()
}
