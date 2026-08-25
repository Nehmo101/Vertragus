import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PtyAgent } from './PtyAgent'
import { PROVIDER_PRESET_IDS } from '@shared/schema/provider'
import {
  PI_CLI_ENTRY_FILE,
  PI_CODING_AGENT_PACKAGE,
  PI_HARNESS_COMMAND,
  PI_MCP_ADAPTER_EXTENSION,
  PI_MCP_ADAPTER_NPM_SPEC,
  PI_MCP_ADAPTER_PACKAGE,
  PI_TTY_PRELOAD_FILE,
  PI_TTY_PRELOAD_SOURCE,
  buildPiHarnessArgv,
  piCliEntrySource,
  piHarnessEnv,
  piMcpAdapterExtension,
  piProviderFor,
  piThinkingFor,
  preferAsarUnpacked,
  resolvePiHarnessCli,
  writePiCliEntry,
  writePiTtyPreload
} from './piHarness'

const requireFromHere = createRequire(import.meta.url)

/** Real Electron binary — not `process.execPath` (Node in vitest) and not the `electron` npm export under `ELECTRON_OVERRIDE_DIST_PATH`. */
function resolveElectronBinary(): string {
  const pkg = dirname(requireFromHere.resolve('electron/package.json'))
  const binary = join(pkg, 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
  if (!existsSync(binary)) {
    throw new Error(`Electron binary missing at ${binary}`)
  }
  return binary
}

function wrapCwdWithPiMcp(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'vertragus-pi-cwd-'))
  mkdirSync(join(cwd, '.pi'), { recursive: true })
  writeFileSync(
    join(cwd, '.pi', 'mcp.json'),
    JSON.stringify({
      mcpServers: { vertragus: { url: 'http://127.0.0.1:9/mcp', lifecycle: 'eager' } }
    })
  )
  return cwd
}

const PI_WRAP_ARGV = [
  '--no-session',
  '--approve',
  '--no-extensions',
  '-e',
  PI_MCP_ADAPTER_EXTENSION,
  '--provider',
  'anthropic',
  '--model',
  'opus',
  'Fix login'
] as const

function waitForPiTui(child: {
  stdout?: NodeJS.ReadableStream | null
  stderr?: NodeJS.ReadableStream | null
  kill: () => void
  on: (event: 'exit', cb: (code: number | null) => void) => void
}): Promise<{ out: string }> {
  return new Promise((resolve) => {
    let out = ''
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      try {
        child.kill()
      } catch {
        // Already exited.
      }
      resolve({ out })
    }
    const onChunk = (chunk: Buffer | string) => {
      out += chunk.toString()
      if (out.includes('?2004h')) finish()
    }
    child.stdout?.on('data', onChunk)
    child.stderr?.on('data', onChunk)
    setTimeout(finish, 8_000)
    child.on('exit', finish)
  })
}

describe('piProviderFor', () => {
  it('maps each shipped preset onto a published Pi backend, and omits Ollama', () => {
    expect(piProviderFor('claude')).toBe('anthropic')
    expect(piProviderFor('codex')).toBe('openai-codex')
    expect(piProviderFor('kimi')).toBe('kimi-coding')
    expect(piProviderFor('cursor')).toBe('github-copilot')
    expect(piProviderFor('grok')).toBe('xai')
    expect(piProviderFor('ollama')).toBeUndefined()
  })

  it('omits --provider for custom slots and unknown ids', () => {
    expect(piProviderFor(undefined)).toBeUndefined()
    expect(piProviderFor('custom')).toBeUndefined()
    expect(piProviderFor('pi')).toBeUndefined()
  })

  it('covers every shipped preset id so a seventh preset cannot slip through unmapped', () => {
    expect(PROVIDER_PRESET_IDS).not.toContain('pi')
    const mapped = PROVIDER_PRESET_IDS.map((id) => [id, piProviderFor(id)] as const)
    expect(mapped).toEqual([
      ['claude', 'anthropic'],
      ['codex', 'openai-codex'],
      ['kimi', 'kimi-coding'],
      ['cursor', 'github-copilot'],
      ['grok', 'xai'],
      ['ollama', undefined]
    ])
  })
})

describe('piThinkingFor', () => {
  it('passes low/medium/high through and omits an empty effort', () => {
    expect(piThinkingFor('low')).toBe('low')
    expect(piThinkingFor('medium')).toBe('medium')
    expect(piThinkingFor('high')).toBe('high')
    expect(piThinkingFor(undefined)).toBeUndefined()
  })
})

describe('lockfile Pi CLI and adapter', () => {
  it('resolves the packaged bin.pi entry, not a PATH name', () => {
    const cli = resolvePiHarnessCli()
    expect(cli).toBeDefined()
    expect(cli).toMatch(/dist[/\\]cli\.js$/)
    expect(existsSync(cli!)).toBe(true)
    expect(PI_HARNESS_COMMAND).toBe('pi')
    expect(PI_CODING_AGENT_PACKAGE).toBe('@earendil-works/pi-coding-agent')
  })

  it('pins the adapter to the installed version and prefers the lockfile copy', () => {
    expect(PI_MCP_ADAPTER_PACKAGE).toBe('pi-mcp-adapter')
    expect(PI_MCP_ADAPTER_NPM_SPEC).toMatch(/^npm:pi-mcp-adapter@\d+\.\d+\.\d+/)
    expect(piMcpAdapterExtension()).toBe(PI_MCP_ADAPTER_EXTENSION)
    expect(existsSync(PI_MCP_ADAPTER_EXTENSION)).toBe(true)
    expect(PI_MCP_ADAPTER_EXTENSION).not.toMatch(/^npm:/)
  })

  it('only sets ELECTRON_RUN_AS_NODE when a bundled CLI path exists', () => {
    expect(piHarnessEnv(undefined)).toBeUndefined()
    expect(piHarnessEnv('/tmp/pi/dist/cli.js')).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
  })

  it('writes a CJS TTY polyfill that forces isTTY and a setRawMode stub', () => {
    const root = mkdtempSync(join(tmpdir(), 'vertragus-pi-preload-'))
    const path = writePiTtyPreload(root)
    expect(path).toBe(join(root, 'vertragus-mcp', PI_TTY_PRELOAD_FILE))
    expect(existsSync(path)).toBe(true)
    const source = readFileSync(path, 'utf8')
    expect(source).toBe(PI_TTY_PRELOAD_SOURCE)
    expect(source).toContain("defineProperty(stream, 'isTTY'")
    expect(source).toContain('process.stdin')
    expect(source).toContain('process.stdout')
    expect(source).toContain('process.stderr')
    expect(source).toContain('setRawMode')
    expect(source).toContain('columns')
  })

  it('writes an entry script that polyfills TTY then imports the CLI — not Node -r', () => {
    const root = mkdtempSync(join(tmpdir(), 'vertragus-pi-entry-'))
    const cli = join(root, 'cli.js')
    const path = writePiCliEntry(root, cli)
    expect(path).toBe(join(root, 'vertragus-mcp', PI_CLI_ENTRY_FILE))
    const source = readFileSync(path, 'utf8')
    expect(source).toBe(piCliEntrySource(cli))
    expect(source.startsWith(PI_TTY_PRELOAD_SOURCE)).toBe(true)
    expect(source).toContain('pathToFileURL')
    expect(source).toContain(JSON.stringify(cli))
    expect(source).not.toContain(' -r ')
  })

  it('forces stdin/stdout.isTTY before the imported module runs, even on a pipe', () => {
    const root = mkdtempSync(join(tmpdir(), 'vertragus-pi-tty-'))
    const stub = join(root, 'stub.mjs')
    writeFileSync(
      stub,
      `process.stdout.write(JSON.stringify({
  stdin: process.stdin.isTTY === true,
  stdout: process.stdout.isTTY === true,
  setRawMode: typeof process.stdin.setRawMode
}))
`
    )
    const entry = writePiCliEntry(root, stub)
    const result = spawnSync(process.execPath, [entry], {
      encoding: 'utf8',
      timeout: 8_000,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      stdin: true,
      stdout: true,
      setRawMode: 'function'
    })
  })

  it('does not process.exit(1) when stdio is a pipe and a first goal is present', async () => {
    const cli = resolvePiHarnessCli()
    expect(cli).toBeDefined()
    const root = mkdtempSync(join(tmpdir(), 'vertragus-pi-goal-'))
    const cwd = wrapCwdWithPiMcp()
    const entry = writePiCliEntry(root, cli!)
    const child = spawn(process.execPath, [entry, ...PI_WRAP_ARGV], {
      cwd,
      env: { ...process.env, HOME: cwd, PI_SKIP_VERSION_CHECK: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const result = await waitForPiTui(child)
    // Print mode plus a goal plus no Pi API key is process.exit(1) with a
    // plain "No API key found" line. Interactive mode enables bracketed paste
    // (DECSET 2004) and then stays up or exits 0 on stdin EOF.
    expect(result.out).toContain('?2004h')
    expect(result.out).not.toMatch(/No API key found/i)
  }, 12_000)

  it('Electron-as-node on a pipe without the CJS entry still exits 1 (print mode + goal + no Pi key)', () => {
    const cli = resolvePiHarnessCli()
    expect(cli).toBeDefined()
    const cwd = wrapCwdWithPiMcp()
    const result = spawnSync(resolveElectronBinary(), [cli!, ...PI_WRAP_ARGV], {
      cwd,
      env: { ...process.env, HOME: cwd, ELECTRON_RUN_AS_NODE: '1', PI_SKIP_VERSION_CHECK: '1' },
      encoding: 'utf8',
      timeout: 8_000,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(`${result.stdout}${result.stderr}`).toMatch(/No API key found/i)
  }, 12_000)

  it('Electron-as-node on a pipe with the CJS entry does not process.exit(1)', async () => {
    const cli = resolvePiHarnessCli()
    expect(cli).toBeDefined()
    const root = mkdtempSync(join(tmpdir(), 'vertragus-pi-electron-pipe-'))
    const cwd = wrapCwdWithPiMcp()
    const entry = writePiCliEntry(root, cli!)
    const child = spawn(resolveElectronBinary(), [entry, ...PI_WRAP_ARGV], {
      cwd,
      env: { ...process.env, HOME: cwd, ELECTRON_RUN_AS_NODE: '1', PI_SKIP_VERSION_CHECK: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const result = await waitForPiTui(child)
    expect(result.out).toContain('?2004h')
    expect(result.out).not.toMatch(/No API key found/i)
  }, 12_000)

  it('Electron-as-node on a PTY with the CJS entry stays up (production spawn shape)', async () => {
    const cli = resolvePiHarnessCli()
    expect(cli).toBeDefined()
    const root = mkdtempSync(join(tmpdir(), 'vertragus-pi-electron-pty-'))
    const cwd = wrapCwdWithPiMcp()
    const entry = writePiCliEntry(root, cli!)
    const pty = new PtyAgent()
    const result = await new Promise<{ out: string }>((resolve) => {
      let out = ''
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        stopData()
        stopExit()
        pty.kill()
        resolve({ out })
      }
      const stopData = pty.onData((chunk) => {
        out += chunk
        if (out.includes('?2004h')) finish()
      })
      const stopExit = pty.onExit(finish)
      pty.spawn({
        file: resolveElectronBinary(),
        args: [entry, ...PI_WRAP_ARGV],
        cwd,
        env: { HOME: cwd, ELECTRON_RUN_AS_NODE: '1', PI_SKIP_VERSION_CHECK: '1' }
      })
      setTimeout(finish, 8_000)
    })
    expect(result.out).toContain('?2004h')
    expect(result.out).not.toMatch(/No API key found/i)
  }, 12_000)

  it('rewrites app.asar to app.asar.unpacked when that copy exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'vertragus-asar-'))
    const asarFile = join(root, 'app.asar', 'node_modules', 'pkg', 'cli.js')
    const unpackedFile = join(root, 'app.asar.unpacked', 'node_modules', 'pkg', 'cli.js')
    mkdirSync(join(root, 'app.asar', 'node_modules', 'pkg'), { recursive: true })
    mkdirSync(join(root, 'app.asar.unpacked', 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(unpackedFile, 'unpacked\n')
    expect(preferAsarUnpacked(asarFile)).toBe(unpackedFile)
    expect(preferAsarUnpacked(unpackedFile)).toBe(unpackedFile)
    expect(preferAsarUnpacked(join(root, 'plain', 'cli.js'))).toBe(join(root, 'plain', 'cli.js'))
  })
})

describe('buildPiHarnessArgv', () => {
  it('loads only the MCP adapter, trusts project files, and does not save a session', () => {
    expect(buildPiHarnessArgv({})).toEqual([
      '--no-session',
      '--approve',
      '--no-extensions',
      '-e',
      PI_MCP_ADAPTER_EXTENSION
    ])
    expect(PI_HARNESS_COMMAND).toBe('pi')
  })

  it('composes a Claude-slot wrap: anthropic + model + thinking + system prompt', () => {
    expect(
      buildPiHarnessArgv({
        presetId: 'claude',
        model: 'opus',
        effort: 'high',
        systemPrompt: 'You orchestrate.',
        initialPrompt: 'Fix the login bug'
      })
    ).toEqual([
      '--no-session',
      '--approve',
      '--no-extensions',
      '-e',
      PI_MCP_ADAPTER_EXTENSION,
      '--provider',
      'anthropic',
      '--model',
      'opus',
      '--thinking',
      'high',
      '--append-system-prompt',
      'You orchestrate.',
      'Fix the login bug'
    ])
  })

  it('does not pass Ollama provider.args leftovers — omit --provider, keep --model', () => {
    const argv = buildPiHarnessArgv({ presetId: 'ollama', model: 'qwen3:32b' })
    expect(argv).not.toContain('--provider')
    expect(argv).not.toContain('run')
    expect(argv).not.toContain('--nowordwrap')
    expect(argv).toEqual([
      '--no-session',
      '--approve',
      '--no-extensions',
      '-e',
      PI_MCP_ADAPTER_EXTENSION,
      '--model',
      'qwen3:32b'
    ])
  })

  it('does not forward native yolo flags — Pi has no permission prompts', () => {
    const argv = buildPiHarnessArgv({ presetId: 'claude' })
    expect(argv.join(' ')).not.toMatch(/yolo|dangerously|always-approve/)
  })

  it('trims blank model / prompt so Pi does not see empty flags', () => {
    expect(buildPiHarnessArgv({ model: '  ', systemPrompt: '  ', initialPrompt: '' })).toEqual([
      '--no-session',
      '--approve',
      '--no-extensions',
      '-e',
      PI_MCP_ADAPTER_EXTENSION
    ])
  })

  it('prefers an append-system-prompt file path over inline text', () => {
    expect(
      buildPiHarnessArgv({
        systemPrompt: 'inline, should not win',
        appendSystemPromptFile: '/tmp/work/.pi/APPEND_SYSTEM.md'
      })
    ).toEqual([
      '--no-session',
      '--approve',
      '--no-extensions',
      '-e',
      PI_MCP_ADAPTER_EXTENSION,
      '--append-system-prompt',
      '/tmp/work/.pi/APPEND_SYSTEM.md'
    ])
  })
})
