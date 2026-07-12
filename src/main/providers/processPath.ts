import { execFile } from 'node:child_process'
import { delimiter } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const WINDOWS_PATH_SCRIPT = [
  "$machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')",
  "$user = [Environment]::GetEnvironmentVariable('Path', 'User')",
  '[Console]::Out.WriteLine($machine)',
  '[Console]::Out.Write($user)'
].join('; ')

/** Merge PATH values without dropping app-specific entries inherited at launch. */
export function mergePathValues(separator: string, ...values: Array<string | undefined>): string {
  const seen = new Set<string>()
  const entries: string[] = []
  for (const value of values) {
    for (const rawEntry of value?.split(separator) ?? []) {
      const entry = rawEntry.trim()
      if (!entry) continue
      const key = entry.replace(/[\\/]+$/, '').toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      entries.push(entry)
    }
  }
  return entries.join(separator)
}

/**
 * Refresh the long-running Electron process after a Windows installer updates
 * PATH. Windows only propagates environment changes to newly started processes,
 * but the Provider refresh button should also discover newly installed CLIs.
 */
export async function refreshProcessPathFromSystem(): Promise<void> {
  if (process.platform !== 'win32') return

  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_PATH_SCRIPT],
      { windowsHide: true }
    )
    const [machinePath = '', userPath = ''] = stdout.split(/\r?\n/, 2)
    const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
    process.env[pathKey] = mergePathValues(
      delimiter,
      process.env[pathKey],
      machinePath,
      userPath
    )
  } catch {
    // Best effort only. Existing PATH-based probing still reports a useful error.
  }
}
