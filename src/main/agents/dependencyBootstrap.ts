import { execFile } from 'node:child_process'
import { access, readFile, symlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { resolveLaunch } from '@main/agents/resolveCommand'

const execFileAsync = promisify(execFile)
const installs = new Map<string, Promise<void>>()

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
      label: 'pnpm'
    }
  }
  if (await exists(join(root, 'yarn.lock'))) {
    return {
      command: 'corepack',
      args: ['yarn', 'install', '--immutable'],
      label: 'yarn'
    }
  }
  if (await exists(join(root, 'package-lock.json'))) {
    return { command: 'npm', args: ['ci'], label: 'npm' }
  }
  if (await exists(join(root, 'bun.lock')) || await exists(join(root, 'bun.lockb'))) {
    return {
      command: 'bun',
      args: ['install', '--frozen-lockfile'],
      label: 'bun'
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

async function installDependencies(installDir: string, command: InstallCommand): Promise<void> {
  let pending = installs.get(installDir)
  if (!pending) {
    pending = resolveLaunch(command.command, command.args)
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
            `Dependency-Bootstrap (${command.label}) fehlgeschlagen: '${command.command}' wurde nicht ` +
            'gefunden. PATH des App-Prozesses prüfen — Versionsmanager wie fnm/nvm verlinken oft nur ' +
            'node; corepack/npm müssen daneben verfügbar sein.'
          )
        }
        throw error
      })
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
    await installDependencies(workingDir, command)
    if (!await exists(workerModules)) {
      throw new Error('Dependency-Bootstrap lief durch, aber node_modules fehlt weiterhin.')
    }
    return {
      status: 'installed',
      toolchain,
      detail: `Dependencies wurden mit ${command.label} direkt im Worktree installiert.`
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
