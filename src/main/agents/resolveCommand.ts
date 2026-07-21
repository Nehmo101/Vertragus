/**
 * Cross-platform executable resolution for PTY spawning.
 *
 * On Windows many agent CLIs are shims (.cmd/.ps1) that a PTY cannot exec
 * directly — wrap them in cmd.exe / powershell.exe. On POSIX the command
 * resolves via PATH and runs as-is.
 *
 * Argument-faithful launches (see {@link ResolveLaunchOptions.requireFaithfulArgs})
 * deliberately avoid the cmd.exe wrapper: cmd.exe treats a newline inside an
 * argument as a command boundary, so a multiline prompt is truncated at the
 * first line and unescaped shell metacharacters (&, |, <, >, ^, %, !, quotes)
 * can inject a second command. Instead the shim is rewritten to a direct
 * executable / Node entrypoint that receives its arguments through the standard
 * CommandLineToArgvW round-trip, which preserves newlines and metacharacters
 * byte-for-byte.
 */
import { execFile } from 'node:child_process'
import { access, readFile, realpath } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { refreshProcessPathFromSystem } from '@main/providers/processPath'

const execFileAsync = promisify(execFile)

export interface ResolvedLaunch {
  file: string
  args: string[]
}

export interface ResolveLaunchOptions {
  /**
   * Require an argument-faithful entrypoint. When a resolved command is a
   * Windows script shim (.cmd/.bat/.ps1) this refuses the cmd.exe/powershell
   * wrapper — which cannot carry newlines or shell metacharacters safely — and
   * resolves a direct executable / Node entrypoint instead. If none can be
   * found the call throws rather than silently corrupting the arguments, so the
   * failure surfaces at preflight/dispatch instead of as a truncated prompt.
   */
  requireFaithfulArgs?: boolean
  /** Platform override for testing the Windows resolution off-Windows. */
  platform?: NodeJS.Platform
}

const cache = new Map<string, string>()

/** Order matters: prefer real executables over script shims. */
const WIN_EXT_PRIORITY = ['.exe', '.com', '.cmd', '.bat', '.ps1']

/** Script-shim extensions that cannot receive arguments faithfully via a shell. */
const SHIM_EXTENSIONS = ['.cmd', '.bat', '.ps1']

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

function lowerExtEndsWith(path: string, ext: string): boolean {
  return path.toLowerCase().endsWith(ext)
}

/**
 * Rewrite a shim-referenced path (`%~dp0\..\pkg\cli.js`, `$basedir/cli.js`,
 * `%dp0%\node_modules\pkg\bin\cli.js`) into an absolute filesystem path.
 * Returns undefined when the reference cannot be resolved to a concrete path.
 *
 * Uses the runtime path module so the same logic is testable off-Windows; both
 * `\` and `/` separators from real Windows shims are normalized.
 */
export function resolveShimReference(reference: string, shimDir: string): string | undefined {
  let ref = reference.trim().replace(/^["']+|["']+$/g, '')
  if (!ref) return undefined
  // Windows drive-absolute references (C:\...) are used verbatim.
  if (/^[a-zA-Z]:[\\/]/.test(ref)) return ref.replace(/[\\/]+/g, sep)
  // Strip the shim base-directory placeholders emitted by cmd-shim / npm / pnpm.
  ref = ref
    .replace(/^%~?dp0%?/i, '')
    .replace(/^\$(?:basedir|psscriptroot)/i, '')
    .replace(/^[\\/]+/, '')
    .replace(/[\\/]+/g, sep)
  if (!ref) return undefined
  if (isAbsolute(ref)) return ref
  return resolve(shimDir, ref)
}

export interface ShimEntrypoint {
  kind: 'node' | 'exe'
  path: string
}

/**
 * Extract the real program a Windows script shim wraps. cmd-shim / npm / pnpm /
 * corepack generate a stable shape: the interpreter (`node.exe`) followed by the
 * quoted CLI entry (`"…\cli.js"`), or a directly wrapped native `.exe`. The JS
 * entry is preferred (run via node); a wrapped non-node executable is the
 * fallback. Returns undefined when no direct target can be identified.
 */
export function parseShimEntrypoint(
  shimText: string,
  shimDir: string
): ShimEntrypoint | undefined {
  const quoted = shimText.match(/"[^"\r\n]+"/g) ?? []
  const tokens = quoted.map((token) => token.slice(1, -1))
  for (const token of tokens) {
    if (/\.(?:c|m)?js$/i.test(token)) {
      const path = resolveShimReference(token, shimDir)
      if (path) return { kind: 'node', path }
    }
  }
  for (const token of tokens) {
    if (/\.(?:exe|com)$/i.test(token)) {
      const base = basename(token.replace(/[\\/]+/g, sep)).toLowerCase()
      if (base === 'node.exe' || base === 'node.com') continue
      const path = resolveShimReference(token, shimDir)
      if (path) return { kind: 'exe', path }
    }
  }
  return undefined
}

interface FaithfulShimDeps {
  readShim: (path: string) => Promise<string>
  pathExists: (path: string) => Promise<boolean>
  resolveNode: () => Promise<string>
}

const defaultFaithfulShimDeps: FaithfulShimDeps = {
  readShim: (path) => readFile(path, 'utf8'),
  pathExists: async (path) => {
    try {
      await access(path, fsConstants.F_OK)
      return true
    } catch {
      return false
    }
  },
  resolveNode: () => resolveNodeExecutable()
}

async function resolveNodeExecutable(): Promise<string> {
  const node = await resolvePath('node')
  if (node && node !== 'node') return node
  // The app itself runs on a Node/Electron binary; use it as a last resort.
  return process.execPath
}

/**
 * Resolve a Windows script shim to a directly spawnable, argument-faithful
 * launch. Prefers a sibling real executable (cursor-agent.exe next to
 * cursor-agent.cmd), then the Node/exe entrypoint the shim wraps. Returns
 * undefined when neither can be found.
 */
export async function resolveFaithfulShimLaunch(
  shimPath: string,
  args: string[],
  deps: Partial<FaithfulShimDeps> = {}
): Promise<ResolvedLaunch | undefined> {
  const { readShim, pathExists, resolveNode } = { ...defaultFaithfulShimDeps, ...deps }
  const dir = dirname(shimPath)
  const base = basename(shimPath).replace(/\.[^.]+$/, '')

  // 1) A sibling real executable is the most reliable faithful entrypoint.
  for (const ext of ['.exe', '.com']) {
    const candidate = join(dir, `${base}${ext}`)
    if (await pathExists(candidate)) return { file: candidate, args }
  }

  // 2) Parse the shim for the Node/exe entry it wraps.
  let shimText: string
  try {
    shimText = await readShim(shimPath)
  } catch {
    return undefined
  }
  const entry = parseShimEntrypoint(shimText, dir)
  if (!entry) return undefined
  if (!(await pathExists(entry.path))) return undefined
  if (entry.kind === 'exe') return { file: entry.path, args }
  const node = await resolveNode()
  return { file: node, args: [entry.path, ...args] }
}

export async function resolveLaunch(
  command: string,
  args: string[],
  options: ResolveLaunchOptions = {}
): Promise<ResolvedLaunch> {
  const resolved = await resolvePath(command)
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') return { file: resolved, args }

  const lower = resolved.toLowerCase()
  const isShim = SHIM_EXTENSIONS.some((ext) => lowerExtEndsWith(lower, ext))

  if (options.requireFaithfulArgs) {
    // A real executable already receives arguments faithfully.
    if (!isShim) return { file: resolved, args }
    const faithful = await resolveFaithfulShimLaunch(resolved, args)
    if (faithful) return faithful
    throw new Error(
      `Kein argumenttreuer Startpfad für '${command}' gefunden (aufgelöst zu ${resolved}). ` +
        'Ein cmd.exe/PowerShell-Wrapper würde mehrzeilige Prompts abschneiden und Shell-Metazeichen ' +
        'ausführbar machen. Erwartet wird ein direkt startbares .exe oder ein Node-Entrypoint neben dem Shim.'
    )
  }

  if (lowerExtEndsWith(lower, '.ps1')) {
    return {
      file: 'powershell.exe',
      args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolved, ...args]
    }
  }
  if (lowerExtEndsWith(lower, '.cmd') || lowerExtEndsWith(lower, '.bat')) {
    return { file: 'cmd.exe', args: ['/c', resolved, ...args] }
  }
  return { file: resolved, args }
}
