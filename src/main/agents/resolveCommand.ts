/**
 * Cross-platform executable resolution for PTY spawning.
 *
 * On Windows many agent CLIs are shims (.cmd/.ps1) that a PTY cannot exec
 * directly — wrap them in cmd.exe / powershell.exe. On POSIX the command
 * resolves via PATH and runs as-is.
 */
import { execFile } from 'node:child_process'
import { access, realpath } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { refreshProcessPathFromSystem } from '@main/providers/processPath'

const execFileAsync = promisify(execFile)

export interface ResolvedLaunch {
  file: string
  args: string[]
}

const cache = new Map<string, string>()

/** Order matters: prefer real executables over script shims. */
const WIN_EXT_PRIORITY = ['.exe', '.com', '.cmd', '.bat', '.ps1']

/**
 * Version managers such as fnm/nvm often expose only `node` on the app PATH;
 * pane preflight then dies with `spawn corepack ENOENT` although the toolchain
 * is installed. These commands ship next to the node binary, so the real
 * directory of `node` is a reliable fallback location.
 */
const NODE_SIBLING_COMMANDS = new Set(['corepack', 'npm', 'npx', 'pnpm', 'pnpx', 'yarn'])

async function nodeSiblingFallback(command: string): Promise<string | undefined> {
  if (!NODE_SIBLING_COMMANDS.has(command)) return undefined
  try {
    const node = process.platform === 'win32'
      ? (await execFileAsync('where.exe', ['node'], { windowsHide: true })).stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find(Boolean)
      : await resolvePosixCommand('node')
    if (!node || node === 'node') return undefined
    const binDir = dirname(await realpath(node))
    const names = process.platform === 'win32'
      ? WIN_EXT_PRIORITY.map((ext) => `${command}${ext}`)
      : [command]
    for (const name of names) {
      const candidate = join(binDir, name)
      try {
        await access(candidate, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK)
        return candidate
      } catch {
        // next extension candidate
      }
    }
  } catch {
    // node itself is unresolved — nothing to fall back to
  }
  return undefined
}

async function resolvePosixCommand(command: string): Promise<string> {
  const { stdout } = await execFileAsync(
    '/bin/sh',
    ['-c', 'command -v "$1"', 'orca-command-resolution', command],
    { windowsHide: true }
  )
  return stdout.trim() || command
}

async function resolvePath(command: string): Promise<string> {
  const cached = cache.get(command)
  if (cached) return cached

  let resolved = command
  try {
    if (process.platform === 'win32') {
      let stdout: string
      try {
        ;({ stdout } = await execFileAsync('where.exe', [command], { windowsHide: true }))
      } catch {
        await refreshProcessPathFromSystem()
        ;({ stdout } = await execFileAsync('where.exe', [command], { windowsHide: true }))
      }
      const candidates = stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
      resolved =
        WIN_EXT_PRIORITY.map((ext) =>
          candidates.find((c) => c.toLowerCase().endsWith(ext))
        ).find(Boolean) ??
        candidates[0] ??
        command
    } else {
      try {
        resolved = await resolvePosixCommand(command)
      } catch (error) {
        if (process.platform !== 'darwin') throw error
        // The CLI may have been installed since this Finder-launched app began.
        await refreshProcessPathFromSystem()
        resolved = await resolvePosixCommand(command)
      }
    }
  } catch {
    const fallback = await nodeSiblingFallback(command)
    if (fallback) {
      cache.set(command, fallback)
      return fallback
    }
    // Leave unresolved; the PTY spawn will surface a clear error. Do not cache
    // this miss, because the CLI may be installed while Vertragus keeps running.
    return resolved
  }
  if (resolved === command) {
    const fallback = await nodeSiblingFallback(command)
    if (fallback) {
      cache.set(command, fallback)
      return fallback
    }
  }
  cache.set(command, resolved)
  return resolved
}

export async function resolveLaunch(command: string, args: string[]): Promise<ResolvedLaunch> {
  const resolved = await resolvePath(command)
  const lower = resolved.toLowerCase()
  if (process.platform === 'win32') {
    if (lower.endsWith('.ps1')) {
      return {
        file: 'powershell.exe',
        args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolved, ...args]
      }
    }
    if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
      return { file: 'cmd.exe', args: ['/c', resolved, ...args] }
    }
  }
  return { file: resolved, args }
}
