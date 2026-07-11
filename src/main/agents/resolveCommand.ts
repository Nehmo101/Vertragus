/**
 * Cross-platform executable resolution for PTY spawning.
 *
 * On Windows many agent CLIs are shims (.cmd/.ps1) that a PTY cannot exec
 * directly — wrap them in cmd.exe / powershell.exe. On Linux the command
 * resolves via PATH and runs as-is.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface ResolvedLaunch {
  file: string
  args: string[]
}

const cache = new Map<string, string>()

/** Order matters: prefer real executables over script shims. */
const WIN_EXT_PRIORITY = ['.exe', '.com', '.cmd', '.bat', '.ps1']

async function resolvePath(command: string): Promise<string> {
  const cached = cache.get(command)
  if (cached) return cached

  let resolved = command
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('where.exe', [command], { windowsHide: true })
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
      const { stdout } = await execFileAsync('/bin/sh', ['-c', `command -v ${command}`])
      resolved = stdout.trim() || command
    }
  } catch {
    // Leave unresolved; the PTY spawn will surface a clear error.
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
