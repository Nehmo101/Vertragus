/**
 * Live Pi wrap against a real Vertragus MCP server.
 *
 * The unit suite pins argv and the TTY polyfill. This file pins the thing
 * Play actually needs: the community adapter connects to `/mcp`, lists
 * orchestrator tools, and the TUI stays interactive (DECSET 2004).
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PtyAgent } from '@main/agents/PtyAgent'
import {
  PI_MCP_ADAPTER_EXTENSION,
  isWindowsElectronBinary,
  resolvePiHarnessCli,
  writePiCliEntry
} from '@main/agents/piHarness'
import { spawnAgent } from '@main/agents/spawn'
import { writePiHarnessMcpConfig } from '@main/mcp/attach'
import { providerPreset } from '@main/providers/presets'
import { startMcpServer, type McpServerHandle } from '@main/mcp/server'
import { fakeRuntime } from '@main/mcp/testing'

const requireFromHere = createRequire(import.meta.url)
const TEST_MS = 40_000
const WAIT_MS = 30_000

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
    ...extra
  }
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
  return /servers connected \(\d+ tools\)/.test(out) || /Failed to connect to vertragus/i.test(out)
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
    'eager-attaches orchestrator tools through the community adapter',
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
      const file = electronBinary ?? process.execPath

      const child = spawn(file, [entry, ...PI_WRAP_ARGV], {
        cwd,
        env: piLiveEnv(cwd, electronBinary ? { ELECTRON_RUN_AS_NODE: '1' } : undefined),
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

      expect(out, out.slice(-2000)).toContain('?2004h')
      expect(out, out.slice(-2000)).not.toMatch(/Failed to connect to vertragus/i)
      expect(out, out.slice(-2000)).toMatch(/servers connected \(\d+ tools\)/)
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
          ...(process.platform === 'win32' ? {} : { ELECTRON_RUN_AS_NODE: '1' })
        }
      })
      const out = await pending

      expect(out, out.slice(-2000)).toContain('?2004h')
      expect(out, out.slice(-2000)).not.toMatch(/Failed to connect to vertragus/i)
      expect(out, out.slice(-2000)).toMatch(/servers connected \(\d+ tools\)/)
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
        expect(launch.env).toBeUndefined()
      } else {
        expect(launch.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
      }

      const out = await pending

      expect(out, out.slice(-2000)).toContain('?2004h')
      expect(out, out.slice(-2000)).not.toMatch(/Failed to connect to vertragus/i)
      expect(out, out.slice(-2000)).toMatch(/servers connected \(\d+ tools\)/)
    },
    TEST_MS
  )
})
