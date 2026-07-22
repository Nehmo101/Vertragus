import { execFile } from 'node:child_process'
import { delimiter, posix } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const WINDOWS_PATH_SCRIPT = [
  "$machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')",
  "$user = [Environment]::GetEnvironmentVariable('Path', 'User')",
  '[Console]::Out.WriteLine($machine)',
  '[Console]::Out.Write($user)'
].join('; ')

const DARWIN_PATH_MARKER = '__VERTRAGUS_LOGIN_SHELL_PATH__='
const DARWIN_PATH_SCRIPT = `printf '\\n${DARWIN_PATH_MARKER}%s\\n' "$PATH"`
const DARWIN_SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
const DARWIN_FALLBACK_PATH = '/opt/homebrew/bin:/usr/local/bin'
const TRUSTED_DARWIN_LOGIN_SHELLS = new Set(['/bin/zsh', '/bin/bash', '/bin/sh'])
const UNSAFE_DARWIN_PATH_ROOTS = ['/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp']

function pathEnvironmentKey(): string {
  return Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
}

/** Extract PATH without trusting output written by shell startup files. */
export function darwinLoginShellPath(stdout: string): string | undefined {
  return stdout
    .split(/\r?\n/)
    .reverse()
    .find((line) => line.startsWith(DARWIN_PATH_MARKER))
    ?.slice(DARWIN_PATH_MARKER.length)
    .trim()
}

/** Never execute an arbitrary executable supplied through the inherited environment. */
export function darwinLoginShellExecutable(configuredShell: string | undefined): string {
  const candidate = configuredShell?.trim()
  return candidate && TRUSTED_DARWIN_LOGIN_SHELLS.has(candidate) ? candidate : '/bin/zsh'
}

function safeDarwinDiscoveredPath(value: string | undefined): string {
  return (value?.split(':') ?? [])
    .map((entry) => entry.trim().replace(/[\\/]+$/, ''))
    .filter((entry) => {
      if (!entry || !posix.isAbsolute(entry) || entry.split('/').includes('..')) return false
      const normalized = posix.normalize(entry)
      return !UNSAFE_DARWIN_PATH_ROOTS.some(
        (root) => normalized === root || normalized.startsWith(`${root}/`)
      )
    })
    .join(':')
}

/**
 * Keep OS binaries ahead of inherited and discovered entries. Login-shell
 * additions remain useful for provider CLIs but cannot shadow system tools.
 */
export function darwinProcessPath(
  inheritedPath: string | undefined,
  discoveredPath: string | undefined
): string {
  return mergePathValues(
    ':',
    DARWIN_SYSTEM_PATH,
    inheritedPath,
    DARWIN_FALLBACK_PATH,
    safeDarwinDiscoveredPath(discoveredPath)
  )
}

/** Merge PATH values without dropping app-specific entries inherited at launch. */
export function mergePathValues(separator: string, ...values: Array<string | undefined>): string {
  const seen = new Set<string>()
  const entries: string[] = []
  const caseInsensitive = separator === ';'
  for (const value of values) {
    for (const rawEntry of value?.split(separator) ?? []) {
      const entry = rawEntry.trim()
      if (!entry) continue
      const normalized = entry.replace(/[\\/]+$/, '')
      const key = caseInsensitive ? normalized.toLowerCase() : normalized
      if (seen.has(key)) continue
      seen.add(key)
      entries.push(entry)
    }
  }
  return entries.join(separator)
}

/**
 * Refresh the long-running Electron process from the platform's authoritative
 * user environment. Windows installers update the registry-backed PATH. macOS
 * apps started from Finder do not inherit the user's login-shell PATH, so read
 * it once through that shell and preserve every app-specific inherited entry.
 */
export async function refreshProcessPathFromSystem(): Promise<void> {
  const pathKey = pathEnvironmentKey()
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_PATH_SCRIPT],
        { windowsHide: true, timeout: 5_000 }
      )
      const [machinePath = '', userPath = ''] = stdout.split(/\r?\n/, 2)
      process.env[pathKey] = mergePathValues(
        delimiter,
        process.env[pathKey],
        machinePath,
        userPath
      )
    } catch {
      // Best effort only. Existing PATH-based probing still reports a useful error.
    }
    return
  }

  if (process.platform === 'darwin') {
    let shellPath: string | undefined
    try {
      const shell = darwinLoginShellExecutable(process.env['SHELL'])
      const { stdout } = await execFileAsync(shell, ['-ilc', DARWIN_PATH_SCRIPT], {
        timeout: 5_000,
        maxBuffer: 1024 * 1024
      })
      shellPath = darwinLoginShellPath(stdout)
    } catch {
      // Fall through to deterministic Homebrew/local fallback entries.
    }
    process.env[pathKey] = darwinProcessPath(process.env[pathKey], shellPath)
  }
}
