import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join, parse as parsePath } from 'node:path'

const { execFileMock, accessMock, readFileMock, realpathMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  accessMock: vi.fn(),
  readFileMock: vi.fn(),
  realpathMock: vi.fn()
}))
vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args)
}))
vi.mock('node:fs/promises', () => ({
  access: accessMock,
  readFile: readFileMock,
  realpath: realpathMock
}))
vi.mock('@main/providers/processPath', () => ({
  refreshProcessPathFromSystem: vi.fn(async () => undefined)
}))

import {
  parseShimEntrypoint,
  resolveFaithfulShimLaunch,
  resolveLaunch,
  resolveShimReference
} from './resolveCommand'

type ExecCallback = (error: Error | null, value?: { stdout: string; stderr: string }) => void

const normalize = (value: string): string => value.replace(/\\/g, '/')

// A platform-absolute path (drive-prefixed on Windows, root-prefixed on POSIX)
// so path.resolve/join in the production code produce comparable results on
// every OS the CI matrix runs on.
const ROOT = parsePath(process.cwd()).root
const abs = (...segments: string[]): string => join(ROOT, ...segments)

describe('node toolchain fallback (Retro Lauf 1: spawn corepack ENOENT)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('resolves corepack next to the real node binary when PATH misses it', async () => {
    // fnm/nvm-Szenario: nur `node` ist im PATH auffindbar, corepack fehlt.
    execFileMock.mockImplementation((_file: string, args: string[], _opts: unknown, cb: ExecCallback) => {
      const target = Array.isArray(args) ? args[args.length - 1] : ''
      if (target === 'node') cb(null, { stdout: '/fake/shim/node\n', stderr: '' })
      else cb(new Error('not found'))
    })
    realpathMock.mockResolvedValue('/fake/install/bin/node')
    accessMock.mockImplementation(async (candidate: string) => {
      if (!normalize(candidate).startsWith('/fake/install/bin/corepack')) {
        throw new Error('ENOENT')
      }
    })

    const launch = await resolveLaunch('corepack', ['pnpm', 'install', '--frozen-lockfile'])

    expect(normalize(launch.file)).toMatch(/^\/fake\/install\/bin\/corepack(\.exe|\.com|\.cmd|\.bat)?$/)
    expect(launch.args.slice(-3)).toEqual(['pnpm', 'install', '--frozen-lockfile'])
  })

  it('leaves non-toolchain commands unresolved so the spawn surfaces the real error', async () => {
    execFileMock.mockImplementation((_file: string, _args: string[], _opts: unknown, cb: ExecCallback) => {
      cb(new Error('not found'))
    })

    const launch = await resolveLaunch('definitely-missing-cli', ['--version'])

    expect(launch).toEqual({ file: 'definitely-missing-cli', args: ['--version'] })
    expect(accessMock).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// P0 — argument-faithful Windows shim resolution (cursor-agent.cmd)
// ---------------------------------------------------------------------------

describe('parseShimEntrypoint / resolveShimReference', () => {
  const binDir = abs('opt', 'bin')

  it('extracts the Node CLI entry from an npm/cmd-shim .cmd wrapper', () => {
    const shim =
      '@ECHO off\r\nSETLOCAL\r\n' +
      'IF EXIST "%dp0%\\node.exe" (SET "_prog=%dp0%\\node.exe") ELSE (SET "_prog=node")\r\n' +
      '"%_prog%"  "%dp0%\\node_modules\\cursor-agent\\bin\\cli.js" %*\r\n'
    const entry = parseShimEntrypoint(shim, binDir)
    expect(entry).toEqual({
      kind: 'node',
      path: join(binDir, 'node_modules', 'cursor-agent', 'bin', 'cli.js')
    })
  })

  it('extracts the Node CLI entry from a cmd-shim .ps1 wrapper', () => {
    const shim =
      '#!/usr/bin/env pwsh\n$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent\n' +
      'if (Test-Path "$basedir/node$exe") {\n' +
      '  & "$basedir/node$exe"  "$basedir/node_modules/cursor-agent/bin/cli.js" $args\n} else {\n' +
      '  & "node$exe"  "$basedir/node_modules/cursor-agent/bin/cli.js" $args\n}\n'
    const entry = parseShimEntrypoint(shim, binDir)
    expect(entry).toEqual({
      kind: 'node',
      path: join(binDir, 'node_modules', 'cursor-agent', 'bin', 'cli.js')
    })
  })

  it('extracts a wrapped native executable (not the node interpreter)', () => {
    const shim = '@"%~dp0\\cursor-agent-core.exe" %*\r\n'
    const entry = parseShimEntrypoint(shim, binDir)
    expect(entry).toEqual({ kind: 'exe', path: join(binDir, 'cursor-agent-core.exe') })
  })

  it('returns undefined when no direct target can be identified', () => {
    expect(parseShimEntrypoint('@echo just a batch file\r\n', binDir)).toBeUndefined()
  })

  it('resolves drive-absolute references verbatim', () => {
    // Drive-absolute references are used as-is (only separators normalized).
    const resolved = resolveShimReference('"C:\\tools\\cli.js"', binDir)
    expect(resolved).toBeDefined()
    expect(normalize(resolved!)).toBe('C:/tools/cli.js')
  })
})

const SHIM_CONTENT = new Map<string, string>()
const setShim = (path: string, content: string): void => {
  SHIM_CONTENT.set(normalize(path), content)
}

/** In-memory FS wiring for the Windows resolution unit tests (path-portable). */
function mockWindowsFs(options: { where: Record<string, string>; files: Set<string> }): void {
  execFileMock.mockImplementation(
    (_file: string, args: string[], _opts: unknown, cb: ExecCallback) => {
      const target = Array.isArray(args) ? args[args.length - 1] : ''
      const hit = options.where[String(target)]
      if (hit) cb(null, { stdout: `${hit}\n`, stderr: '' })
      else cb(new Error('not found'))
    }
  )
  const normFiles = new Set([...options.files].map(normalize))
  accessMock.mockImplementation(async (candidate: string) => {
    if (!normFiles.has(normalize(candidate))) throw new Error('ENOENT')
  })
  readFileMock.mockImplementation(async (candidate: string) => {
    const key = normalize(candidate)
    if (!normFiles.has(key)) throw new Error('ENOENT')
    return SHIM_CONTENT.get(key) ?? ''
  })
}

describe('resolveLaunch faithful Windows shim resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    SHIM_CONTENT.clear()
  })

  it('rewrites a cursor-agent.cmd shim to a direct node entrypoint under Windows', async () => {
    const shim = abs('fake', 'bin', 'cursor-alpha.cmd')
    const cli = abs('fake', 'bin', 'node_modules', 'cursor-agent', 'dist', 'cli.js')
    setShim(shim, '"%dp0%\\node.exe"  "%dp0%\\node_modules\\cursor-agent\\dist\\cli.js" %*')
    mockWindowsFs({
      where: { 'cursor-alpha': shim, node: abs('fake', 'node') },
      files: new Set([shim, cli])
    })

    const launch = await resolveLaunch('cursor-alpha', ['--print', '--trust', 'PROMPT'], {
      requireFaithfulArgs: true,
      platform: 'win32'
    })

    expect(launch.file).toBe(abs('fake', 'node'))
    expect(launch.args).toEqual([cli, '--print', '--trust', 'PROMPT'])
  })

  it('prefers a sibling real .exe over parsing the shim', async () => {
    const shim = abs('fake', 'bin', 'cursor-beta.cmd')
    setShim(shim, '"%dp0%\\node.exe" "%dp0%\\cli.js" %*')
    mockWindowsFs({
      where: { 'cursor-beta': shim, node: abs('fake', 'node') },
      files: new Set([shim, abs('fake', 'bin', 'cursor-beta.exe'), abs('fake', 'bin', 'cli.js')])
    })

    const launch = await resolveLaunch('cursor-beta', ['PROMPT'], {
      requireFaithfulArgs: true,
      platform: 'win32'
    })

    expect(launch.file).toBe(abs('fake', 'bin', 'cursor-beta.exe'))
    expect(launch.args).toEqual(['PROMPT'])
  })

  it('refuses to fall back to cmd.exe when no faithful entrypoint exists', async () => {
    const shim = abs('fake', 'bin', 'cursor-gamma.cmd')
    setShim(shim, '@echo opaque native wrapper\r\n')
    mockWindowsFs({ where: { 'cursor-gamma': shim }, files: new Set([shim]) })

    await expect(
      resolveLaunch('cursor-gamma', ['PROMPT'], { requireFaithfulArgs: true, platform: 'win32' })
    ).rejects.toThrow(/argumenttreuer Startpfad/)
  })

  it('leaves .cmd handling for other CLIs unchanged when faithful args are not required', async () => {
    const shim = abs('fake', 'bin', 'other-cli.cmd')
    mockWindowsFs({ where: { 'other-cli': shim }, files: new Set([shim]) })

    const launch = await resolveLaunch('other-cli', ['--version'], { platform: 'win32' })

    expect(launch).toEqual({ file: 'cmd.exe', args: ['/c', shim, '--version'] })
  })

  it('leaves a real .exe launch untouched under faithful mode', async () => {
    const exe = abs('fake', 'bin', 'cursor-real.exe')
    mockWindowsFs({ where: { 'cursor-real': exe }, files: new Set([exe]) })

    const launch = await resolveLaunch('cursor-real', ['PROMPT'], {
      requireFaithfulArgs: true,
      platform: 'win32'
    })

    expect(launch).toEqual({ file: exe, args: ['PROMPT'] })
  })
})

// ---------------------------------------------------------------------------
// Integration: resolve a Windows-style shim to a real node entrypoint and spawn
// it, proving the arguments arrive at the target process byte-faithfully. This
// exercises the actual spawn path, not just an array snapshot.
// ---------------------------------------------------------------------------

describe('faithful shim launch delivers arguments to a real process', () => {
  const dirs: string[] = []
  let realFs: typeof import('node:fs/promises')
  let realSpawn: typeof import('node:child_process').spawn

  beforeEach(async () => {
    realFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    ;({ spawn: realSpawn } = await vi.importActual<typeof import('node:child_process')>(
      'node:child_process'
    ))
  })

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => realFs.rm(dir, { recursive: true, force: true })))
  })

  async function makeShim(): Promise<{ shim: string; dir: string }> {
    const dir = await realFs.mkdtemp(join(tmpdir(), 'orca-shim-'))
    dirs.push(dir)
    // Prints exactly the arguments the target process received, as JSON.
    await realFs.writeFile(
      join(dir, 'echo-args.mjs'),
      'process.stdout.write(JSON.stringify(process.argv.slice(2)))\n'
    )
    // A cmd-shim / npm style wrapper that would otherwise be run via cmd.exe /c.
    const shim = join(dir, 'cursor-agent.cmd')
    await realFs.writeFile(
      shim,
      '@ECHO off\r\nSETLOCAL\r\n"%~dp0\\node.exe"  "%~dp0\\echo-args.mjs" %*\r\n'
    )
    return { shim, dir }
  }

  async function roundtrip(shim: string, args: string[]): Promise<string[]> {
    const launch = await resolveFaithfulShimLaunch(shim, args, {
      readShim: (p) => realFs.readFile(p, 'utf8'),
      pathExists: async (p) => {
        try {
          await realFs.access(p)
          return true
        } catch {
          return false
        }
      },
      // Use the real node running this test as the interpreter.
      resolveNode: async () => process.execPath
    })
    expect(launch, 'shim must resolve to a faithful launch').toBeDefined()
    return await new Promise<string[]>((resolvePromise, reject) => {
      const child = realSpawn(launch!.file, launch!.args, { windowsHide: true })
      let out = ''
      let err = ''
      child.stdout?.on('data', (chunk: Buffer) => {
        out += chunk.toString()
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        err += chunk.toString()
      })
      child.on('error', reject)
      child.on('close', (code) => {
        if (code !== 0) return reject(new Error(`exit ${code}: ${err}`))
        try {
          resolvePromise(JSON.parse(out) as string[])
        } catch (parseError) {
          reject(parseError)
        }
      })
    })
  }

  it('delivers the IDENTITY/TASK-FINGERPRINT multiline prompt as one argument', async () => {
    const { shim } = await makeShim()
    // The exact shape that failed in the real 5-candidate multiagent run:
    // "IDENTITY\n\nTASK-FINGERPRINT" arrived at the process as ["IDENTITY"].
    const prompt = 'Du bist Kandidat CANARY. Antworte nur auf diese Identität.\n\nCANARY-MA-20260720-A'

    const argv = await roundtrip(shim, ['--print', '--trust', prompt, '--output-format', 'stream-json'])

    expect(argv).toEqual(['--print', '--trust', prompt, '--output-format', 'stream-json'])
    // Both halves survive as a single argument — not truncated at the newline.
    expect(argv[2]).toContain('\n\n')
    expect(argv[2]).toContain('CANARY-MA-20260720-A')
  })

  it('preserves LF and CRLF line breaks', async () => {
    const { shim } = await makeShim()
    const lf = 'zeile1\nzeile2\nzeile3'
    const crlf = 'zeile1\r\nzeile2\r\nzeile3'

    const argv = await roundtrip(shim, [lf, crlf])

    expect(argv).toEqual([lf, crlf])
  })

  it('preserves unicode, quotes and other non-ASCII content', async () => {
    const { shim } = await makeShim()
    const unicode = 'Grüße 🌍 日本語 «Zitat» — 100% ✅ "inner" \'apostrophe\''

    const argv = await roundtrip(shim, [unicode])

    expect(argv).toEqual([unicode])
  })

  it('does not execute a second command from shell metacharacters (no injection)', async () => {
    const { shim, dir } = await makeShim()
    const marker = join(dir, 'INJECTED.txt')
    // Every metacharacter cmd.exe acts on. If any were interpreted by a shell,
    // a second command would run and create the marker file.
    const evil =
      `harmless & echo pwned > "${marker}" | type nul ^& (set X=%PATH%) < nul\r\n! "quoted" 'x' \n> tail`

    const argv = await roundtrip(shim, [evil])

    expect(argv).toEqual([evil])
    let markerExists = true
    try {
      await realFs.access(marker)
    } catch {
      markerExists = false
    }
    expect(markerExists, 'no injected command may have run').toBe(false)
  })
})
