/**
 * Live Pi wrap against a real Vertragus MCP server.
 *
 * The unit suite pins argv and the TTY polyfill. This file pins the thing
 * Play actually needs: the community adapter connects to `/mcp`, lists
 * orchestrator tools, and the TUI stays interactive (DECSET 2004).
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { PtyAgent } from '@main/agents/PtyAgent'
import {
  PI_MCP_ADAPTER_EXTENSION,
  PI_MCP_DIRECT_TOOLS_ENV,
  PI_MCP_DIRECT_TOOLS_VALUE,
  isWindowsElectronBinary,
  piHarnessEnv,
  resolvePiHarnessCli,
  writePiCliEntry
} from '@main/agents/piHarness'
import { spawnAgent } from '@main/agents/spawn'
import { writePiHarnessMcpConfig, piMcpRequestTimeoutMs, piVertragusServerEntry } from '@main/mcp/attach'
import { providerPreset } from '@main/providers/presets'
import { startMcpServer, type McpServerHandle } from '@main/mcp/server'
import { fakeRuntime } from '@main/mcp/testing'

const requireFromHere = createRequire(import.meta.url)
const TEST_MS = 40_000
const WAIT_MS = 30_000
const LONG_POLL_MS = 90_000

function resolveElectronBinary(): string | undefined {
  const pkg = dirname(requireFromHere.resolve('electron/package.json'))
  const binary = join(pkg, 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
  return existsSync(binary) ? binary : undefined
}

const electronBinary = resolveElectronBinary()

function piLiveEnv(cwd: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: cwd,
    USERPROFILE: cwd,
    PI_SKIP_VERSION_CHECK: '1',
    [PI_MCP_DIRECT_TOOLS_ENV]: PI_MCP_DIRECT_TOOLS_VALUE,
    ...extra
  }
}

/**
 * Vite resolves bare specifiers from the importer path. The hoisted symlink
 * `node_modules/pi-mcp-adapter` does not see `@modelcontextprotocol/client`
 * (it lives next to the realpath in `.pnpm`). Import the adapter sources
 * from disk so linux/macos CI match Windows quality.
 */
function adapterSourceHref(file: string): string {
  const adapterRoot = PI_MCP_ADAPTER_EXTENSION
  if (adapterRoot.startsWith('npm:')) {
    throw new Error(`adapter is not the lockfile copy: ${adapterRoot}`)
  }
  return pathToFileURL(join(realpathSync(adapterRoot), file)).href
}

type AdapterManagerCtor = new (cwd: string) => {
  connect: (
    name: string,
    definition: Record<string, unknown>
  ) => Promise<{
    client: {
      callTool: (
        params: { name: string; arguments: Record<string, unknown> },
        options?: { timeout?: number }
      ) => Promise<{ isError?: boolean }>
    }
    tools: Array<{ name: string }>
  }>
  getRequestOptions: (name: string) => { timeout?: number } | undefined
  closeAll: () => Promise<void>
}

async function loadAdapterManager(): Promise<AdapterManagerCtor> {
  const { McpServerManager } = (await import(adapterSourceHref('server-manager.ts'))) as {
    McpServerManager: AdapterManagerCtor
  }
  return McpServerManager
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
  'opus'
] as const

function waitForPiOutput(
  subscribe: (onChunk: (chunk: string) => void, onExit: () => void) => () => void,
  done: (out: string) => boolean
): Promise<string> {
  return new Promise((resolve) => {
    let out = ''
    let settled = false
    let stop: () => void = () => {}
    const finish = () => {
      if (settled) return
      settled = true
      stop()
      resolve(out)
    }
    stop = subscribe(
      (chunk) => {
        out += chunk
        if (done(out)) finish()
      },
      finish
    )
    setTimeout(finish, WAIT_MS)
  })
}

function mcpSettled(out: string): boolean {
  if (/Failed to connect to vertragus/i.test(out)) return true
  const connected =
    /1 server enabled \(1 connected\)/.test(out) || /servers connected \(\d+ tools\)/.test(out)
  const direct = /direct tools refreshed \(\+([1-9]\d*)/.test(out)
  return connected && direct
}

function assertPiMcpAttached(out: string): void {
  const snapshot = out.slice(-2500)
  expect(out, snapshot).toContain('?2004h')
  expect(out, snapshot).not.toMatch(/Failed to connect to vertragus/i)
  expect(out, snapshot).toMatch(/1 server enabled \(1 connected\)|servers connected \(([1-9]\d*) tools\)/)
  expect(out, snapshot).toMatch(/direct tools refreshed \(\+([1-9]\d*)/)
}

function vertragusCachedToolNames(agentHome: string): string[] {
  const cachePath = join(agentHome, '.pi', 'agent', 'mcp-cache.json')
  if (!existsSync(cachePath)) return []
  try {
    const cache = JSON.parse(readFileSync(cachePath, 'utf8')) as {
      servers?: { vertragus?: { tools?: Array<{ name?: string }> } }
    }
    return (cache.servers?.vertragus?.tools ?? [])
      .map((tool) => tool.name)
      .filter((name): name is string => typeof name === 'string' && name.length > 0)
  } catch {
    return []
  }
}

async function waitForCachedDirectTools(agentHome: string): Promise<string[]> {
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    const names = vertragusCachedToolNames(agentHome)
    if (names.includes('await_events') && names.includes('start_agent')) return names
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return vertragusCachedToolNames(agentHome)
}

describe('Pi wrap × live Vertragus MCP', () => {
  let handle: McpServerHandle | undefined
  const children: Array<{ kill: () => void }> = []

  afterEach(async () => {
    for (const child of children.splice(0)) {
      try {
        child.kill()
      } catch {
        // Already gone.
      }
    }
    if (handle) {
      await handle.close()
      handle = undefined
    }
  })

  it(
    'attaches orchestrator tools through the community adapter',
    async () => {
      const cli = resolvePiHarnessCli()
      expect(cli).toBeDefined()
      handle = await startMcpServer()
      const runtime = fakeRuntime()
      const registered = handle.registerWorkspace(runtime.ctx)
      const cwd = mkdtempSync(join(tmpdir(), 'vertragus-pi-mcp-'))
      writePiHarnessMcpConfig(registered.orchestratorUrl, cwd)
      const configDir = mkdtempSync(join(tmpdir(), 'vertragus-pi-mcp-cfg-'))
      mkdirSync(join(configDir, 'vertragus-mcp'), { recursive: true })
      const entry = writePiCliEntry(configDir, cli!)
      // Production Windows wrap is PATH node, not Electron-as-node (blank window).
      const useElectron = Boolean(electronBinary) && process.platform !== 'win32'
      const file = useElectron ? electronBinary! : process.execPath

      const child = spawn(file, [entry, ...PI_WRAP_ARGV], {
        cwd,
        env: piLiveEnv(cwd, useElectron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
      children.push(child)

      const out = await waitForPiOutput(
        (onChunk, onExit) => {
          const onBuf = (chunk: Buffer | string): void => onChunk(chunk.toString())
          child.stdout?.on('data', onBuf)
          child.stderr?.on('data', onBuf)
          child.on('exit', onExit)
          return () => {
            child.stdout?.off('data', onBuf)
            child.stderr?.off('data', onBuf)
          }
        },
        (text) => text.includes('?2004h') && mcpSettled(text)
      )

      assertPiMcpAttached(out)
      expect(await registered.waitForSession({ kind: 'orchestrator' }, 2_000)).toBe(true)
      const cached = await waitForCachedDirectTools(cwd)
      expect(cached, cached.join(',')).toEqual(
        expect.arrayContaining(['await_events', 'start_agent'])
      )
    },
    TEST_MS
  )

  it.skipIf(process.platform !== 'win32' && !electronBinary)(
    'production PTY spawn attaches the same way',
    async () => {
      const cli = resolvePiHarnessCli()
      expect(cli).toBeDefined()
      handle = await startMcpServer()
      const runtime = fakeRuntime()
      const registered = handle.registerWorkspace(runtime.ctx)
      const cwd = mkdtempSync(join(tmpdir(), 'vertragus-pi-mcp-pty-'))
      writePiHarnessMcpConfig(registered.orchestratorUrl, cwd)
      const configDir = mkdtempSync(join(tmpdir(), 'vertragus-pi-mcp-pty-cfg-'))
      const entry = writePiCliEntry(configDir, cli!)
      const file = process.platform === 'win32' ? process.execPath : electronBinary!
      const pty = new PtyAgent()
      children.push(pty)
      const pending = waitForPiOutput(
        (onChunk, onExit) => {
          const stopData = pty.onData(onChunk)
          const stopExit = pty.onExit(onExit)
          return () => {
            stopData()
            stopExit()
          }
        },
        (text) => text.includes('?2004h') && mcpSettled(text)
      )
      pty.spawn({
        file,
        args: [entry, ...PI_WRAP_ARGV],
        cwd,
        env: {
          HOME: cwd,
          USERPROFILE: cwd,
          PI_SKIP_VERSION_CHECK: '1',
          [PI_MCP_DIRECT_TOOLS_ENV]: PI_MCP_DIRECT_TOOLS_VALUE,
          ...(process.platform === 'win32' ? {} : { ELECTRON_RUN_AS_NODE: '1' })
        }
      })
      const out = await pending

      assertPiMcpAttached(out)
      expect(await registered.waitForSession({ kind: 'orchestrator' }, 2_000)).toBe(true)
      const cached = await waitForCachedDirectTools(cwd)
      expect(cached, cached.join(',')).toEqual(
        expect.arrayContaining(['await_events', 'start_agent'])
      )
    },
    TEST_MS
  )

  it(
    'Play-shaped spawnAgent (real resolveLaunch) attaches the same way',
    async () => {
      const cli = resolvePiHarnessCli()
      expect(cli).toBeDefined()
      const provider = providerPreset('claude')
      expect(provider).toBeDefined()
      handle = await startMcpServer()
      const runtime = fakeRuntime()
      const registered = handle.registerWorkspace(runtime.ctx)
      const cwd = mkdtempSync(join(tmpdir(), 'vertragus-pi-mcp-play-'))
      const configDir = mkdtempSync(join(tmpdir(), 'vertragus-pi-mcp-play-cfg-'))
      const pty = new PtyAgent()
      const spawnPty = pty.spawn.bind(pty)
      pty.spawn = (options) =>
        spawnPty({
          ...options,
          env: {
            ...process.env,
            ...options.env,
            HOME: cwd,
            USERPROFILE: cwd,
            PI_SKIP_VERSION_CHECK: '1'
          }
        })
      children.push(pty)
      const pending = waitForPiOutput(
        (onChunk, onExit) => {
          const stopData = pty.onData(onChunk)
          const stopExit = pty.onExit(onExit)
          return () => {
            stopData()
            stopExit()
          }
        },
        (text) => text.includes('?2004h') && mcpSettled(text)
      )
      const { launch } = await spawnAgent(
        {
          harness: 'pi',
          kind: 'orchestrator',
          provider: provider!,
          model: 'opus',
          cwd,
          mcpUrl: registered.orchestratorUrl,
          fileTag: 'orch',
          configDir
        },
        { createPty: () => pty }
      )

      if (process.platform === 'win32') {
        expect(launch.file, launch.file).toMatch(/node\.exe$/i)
        expect(isWindowsElectronBinary(launch.file)).toBe(false)
      }
      expect(launch.env).toEqual(piHarnessEnv(cli, process.platform))

      const out = await pending

      assertPiMcpAttached(out)
      expect(await registered.waitForSession({ kind: 'orchestrator' }, 2_000)).toBe(true)
      const wrap = JSON.parse(readFileSync(join(cwd, '.pi', 'mcp.json'), 'utf8')) as {
        settings: { requestTimeoutMs: number; disableProxyTool: boolean }
        mcpServers: { vertragus: { lifecycle: string; requestTimeoutMs: number; idleTimeout: number } }
      }
      expect(wrap.mcpServers.vertragus.lifecycle).toBe('lazy-keep-alive')
      expect(wrap.mcpServers.vertragus.requestTimeoutMs).toBe(600_000)
      expect(wrap.mcpServers.vertragus.idleTimeout).toBe(0)
      expect(wrap.settings.disableProxyTool).toBe(false)
      const cached = await waitForCachedDirectTools(cwd)
      expect(cached, cached.join(',')).toEqual(
        expect.arrayContaining(['await_events', 'start_agent'])
      )
    },
    TEST_MS
  )

  it('imports McpServerManager from the lockfile adapter realpath', async () => {
    expect(PI_MCP_ADAPTER_EXTENSION.startsWith('npm:'), PI_MCP_ADAPTER_EXTENSION).toBe(false)
    const Manager = await loadAdapterManager()
    expect(typeof Manager).toBe('function')
  })

  it(
    'holds await_events past 60s through the adapter manager and wrap timeout',
    async () => {
      handle = await startMcpServer()
      const runtime = fakeRuntime({ awaitTimeout: { defaultSec: 65, maxSec: 65 } })
      const registered = handle.registerWorkspace(runtime.ctx)
      const McpServerManager = await loadAdapterManager()
      const cwd = mkdtempSync(join(tmpdir(), 'vertragus-pi-mgr-'))
      const manager = new McpServerManager(cwd)
      const entry = piVertragusServerEntry(registered.orchestratorUrl)
      try {
        const connection = await manager.connect('vertragus', entry)
        expect(connection.tools.map((tool) => tool.name)).toEqual(
          expect.arrayContaining(['await_events', 'start_agent'])
        )
        const options = manager.getRequestOptions('vertragus')
        expect(options?.timeout).toBe(piMcpRequestTimeoutMs())
        const started = Date.now()
        const result = await connection.client.callTool(
          { name: 'await_events', arguments: { cursor: 0, timeoutSec: 65 } },
          options
        )
        const elapsed = Date.now() - started
        expect(elapsed, `poll returned after ${elapsed}ms`).toBeGreaterThan(60_000)
        expect(result.isError).not.toBe(true)
      } finally {
        await manager.closeAll()
      }
    },
    LONG_POLL_MS
  )
})
