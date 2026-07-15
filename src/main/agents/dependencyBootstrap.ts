import { execFile } from 'node:child_process'
import { access, readFile, symlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { resolveLaunch } from '@main/agents/resolveCommand'

const execFileAsync = promisify(execFile)
const installs = new Map<string, Promise<void>>()

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

async function installCommand(root: string): Promise<InstallCommand | undefined> {
  if (await exists(join(root, 'pnpm-lock.yaml'))) {
    return {
      command: 'corepack',
      args: ['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts'],
      label: 'pnpm'
    }
  }
  if (await exists(join(root, 'yarn.lock'))) {
    return {
      command: 'corepack',
      args: ['yarn', 'install', '--immutable', '--mode=skip-build'],
      label: 'yarn'
    }
  }
  if (await exists(join(root, 'package-lock.json'))) {
    return { command: 'npm', args: ['ci', '--ignore-scripts'], label: 'npm' }
  }
  if (await exists(join(root, 'bun.lock')) || await exists(join(root, 'bun.lockb'))) {
    return {
      command: 'bun',
      args: ['install', '--frozen-lockfile', '--ignore-scripts'],
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

async function installDependencies(root: string, command: InstallCommand): Promise<void> {
  let pending = installs.get(root)
  if (!pending) {
    pending = resolveLaunch(command.command, command.args)
      .then((launch) => execFileAsync(launch.file, launch.args, {
        cwd: root,
        windowsHide: true,
        timeout: 180_000,
        maxBuffer: 8 * 1024 * 1024
      }))
      .then(() => undefined)
    installs.set(root, pending)
    void pending.finally(() => installs.delete(root)).catch(() => undefined)
  }
  await pending
}

/**
 * Every worktree shares the dependency tree of the primary checkout. If it is
 * missing, Orca performs one immutable, script-free bootstrap before linking it.
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

  let installed = false
  if (!await exists(rootModules)) {
    const command = await installCommand(repositoryRoot)
    if (!command) {
      throw new Error('Dependencies fehlen und es wurde kein unterstützter Lockfile-Toolchain erkannt.')
    }
    await installDependencies(repositoryRoot, command)
    installed = true
  }
  if (!await exists(rootModules)) {
    throw new Error('Dependency-Bootstrap lief durch, aber node_modules fehlt weiterhin.')
  }

  if (repositoryRoot === workingDir) {
    return {
      status: installed ? 'installed' : 'present',
      toolchain,
      detail: installed ? 'Dependencies wurden unveränderlich installiert.' : 'Dependencies sind vorhanden.'
    }
  }

  await symlink(rootModules, workerModules, process.platform === 'win32' ? 'junction' : 'dir')
  return {
    status: installed ? 'installed' : 'linked',
    toolchain,
    detail: installed
      ? 'Dependencies wurden installiert und als gemeinsamer Cache verknüpft.'
      : 'Worktree verwendet den gemeinsamen Dependency-/Build-Cache.'
  }
}
