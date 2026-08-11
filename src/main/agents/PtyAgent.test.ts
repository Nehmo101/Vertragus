import type { IPty, IPtyForkOptions } from '@lydell/node-pty'
import { describe, expect, it, vi, type Mock } from 'vitest'
import { DEFAULT_COLS, DEFAULT_ROWS, PtyAgent } from './PtyAgent'

/**
 * These run against real PTY processes (node itself, short-lived) — a mocked
 * node-pty would prove nothing about the part that actually breaks: ConPTY on
 * Windows, forkpty on POSIX, and the kill escalation.
 */
const NODE = process.execPath
const TIMEOUT = 20_000

/** Electron's binary needs this to behave like plain node when we spawn it. */
const NODE_ENV_OVERRIDE = { ELECTRON_RUN_AS_NODE: '1' }

function waitForOutput(agent: PtyAgent, needle: string, timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const check = (): boolean => {
      if (!agent.snapshot().includes(needle)) return false
      cleanup()
      resolve(agent.snapshot())
      return true
    }
    const stop = agent.onData(() => check())
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`timed out waiting for ${JSON.stringify(needle)} in: ${agent.snapshot()}`))
    }, timeoutMs)
    const cleanup = (): void => {
      stop()
      clearTimeout(timer)
    }
    check()
  })
}

function waitForExit(agent: PtyAgent, timeoutMs = 15_000): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for exit')), timeoutMs)
    agent.onExit(({ exitCode }) => {
      clearTimeout(timer)
      resolve(exitCode)
    })
  })
}

describe('PtyAgent (real processes)', () => {
  it(
    'streams output of a short-lived process and reports the exit code',
    async () => {
      const agent = new PtyAgent()
      const chunks: string[] = []
      agent.onData((data) => chunks.push(data))
      agent.spawn({
        file: NODE,
        args: ['-e', 'process.stdout.write("ready-marker")'],
        env: NODE_ENV_OVERRIDE
      })

      expect(agent.pid).toBeGreaterThan(0)
      expect(agent.isAlive).toBe(true)
      await waitForOutput(agent, 'ready-marker')
      const code = await waitForExit(agent)

      expect(code).toBe(0)
      expect(agent.isAlive).toBe(false)
      expect(chunks.join('')).toContain('ready-marker')
    },
    TIMEOUT
  )

  it(
    'writes keystrokes into the process stdin',
    async () => {
      const agent = new PtyAgent()
      agent.spawn({
        file: NODE,
        args: [
          '-e',
          'process.stdout.write("prompt>");process.stdin.on("data",(d)=>{process.stdout.write("|got:"+d.toString().trim());process.exit(0)})'
        ],
        env: NODE_ENV_OVERRIDE
      })

      await waitForOutput(agent, 'prompt>')
      agent.write('ping\r')
      await waitForOutput(agent, '|got:ping')
      await waitForExit(agent)
    },
    TIMEOUT
  )

  it(
    'keeps a scrollback snapshot for listeners that attach late',
    async () => {
      const agent = new PtyAgent()
      agent.spawn({
        file: NODE,
        args: ['-e', 'process.stdout.write("scrollback-marker")'],
        env: NODE_ENV_OVERRIDE
      })
      await waitForOutput(agent, 'scrollback-marker')
      await waitForExit(agent)

      const late: string[] = []
      agent.onData((data) => late.push(data))
      expect(late).toEqual([])
      expect(agent.snapshot()).toContain('scrollback-marker')
      expect(agent.tail(4000)).toContain('scrollback-marker')
    },
    TIMEOUT
  )

  it(
    'kills a long-running process through the escalation chain',
    async () => {
      const agent = new PtyAgent()
      agent.spawn({
        file: NODE,
        args: ['-e', 'process.stdout.write("alive");setInterval(()=>{},1000)'],
        env: NODE_ENV_OVERRIDE
      })
      await waitForOutput(agent, 'alive')

      const exited = waitForExit(agent)
      agent.kill()
      agent.kill() // idempotent — a second stop click must not throw
      await exited

      expect(agent.isAlive).toBe(false)
      expect(agent.exit).toBeDefined()
    },
    TIMEOUT
  )

  it(
    'notifies exit listeners that register after the process is gone',
    async () => {
      const agent = new PtyAgent()
      agent.spawn({ file: NODE, args: ['-e', '0'], env: NODE_ENV_OVERRIDE })
      await waitForExit(agent)

      const seen = await new Promise<number>((resolve) => agent.onExit((i) => resolve(i.exitCode)))
      expect(seen).toBe(0)
    },
    TIMEOUT
  )

  it(
    'resizes the live terminal and remembers the geometry',
    async () => {
      const agent = new PtyAgent()
      agent.spawn({
        file: NODE,
        args: ['-e', 'process.stdout.write("size-ready");setInterval(()=>{},1000)'],
        cols: 80,
        rows: 24,
        env: NODE_ENV_OVERRIDE
      })
      await waitForOutput(agent, 'size-ready')

      expect(agent.cols).toBe(80)
      expect(agent.rows).toBe(24)
      agent.resize(120, 40)
      expect(agent.cols).toBe(120)
      expect(agent.rows).toBe(40)
      agent.resize(0, 0)
      expect(agent.cols).toBe(120)

      const exited = waitForExit(agent)
      agent.kill()
      await exited
    },
    TIMEOUT
  )
})

type SpawnFn = (file: string, args: string[] | string, options: IPtyForkOptions) => IPty

function fakeSpawn(): Mock<SpawnFn> {
  const fakePty = {
    pid: 4711,
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn()
  }
  return vi.fn(
    (_file: string, _args: string[] | string, _options: IPtyForkOptions) =>
      fakePty as unknown as IPty
  )
}

describe('PtyAgent (no process)', () => {
  it('starts with the default geometry and no pid', () => {
    const agent = new PtyAgent()
    expect(agent.pid).toBeUndefined()
    expect(agent.isAlive).toBe(false)
    expect(agent.cols).toBe(DEFAULT_COLS)
    expect(agent.rows).toBe(DEFAULT_ROWS)
    expect(agent.snapshot()).toBe('')
    // Every entry point must survive being called before/without a process.
    expect(() => agent.write('x')).not.toThrow()
    expect(() => agent.resize(10, 10)).not.toThrow()
    expect(() => agent.kill()).not.toThrow()
  })

  it('refuses a second spawn', () => {
    const spawn = fakeSpawn()
    const agent = new PtyAgent({ spawn })
    agent.spawn({ file: 'anything' })
    expect(() => agent.spawn({ file: 'anything' })).toThrow(/already spawned/)
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('drops undefined env entries before handing them to node-pty', () => {
    const spawn = fakeSpawn()
    const agent = new PtyAgent({ spawn })
    agent.spawn({ file: 'x', env: { KEEP: 'yes', DROP: undefined } })

    const env = (spawn.mock.calls[0]![2].env ?? {}) as Record<string, string>
    expect(env.KEEP).toBe('yes')
    expect('DROP' in env).toBe(false)
  })

  it('buffers pushed text (spawn errors) and fans it out to listeners', () => {
    const agent = new PtyAgent()
    const seen: string[] = []
    const stop = agent.onData((data) => seen.push(data))
    agent.push('spawn failed\r\n')
    stop()
    agent.push('after unsubscribe\r\n')

    expect(seen).toEqual(['spawn failed\r\n'])
    expect(agent.snapshot()).toBe('spawn failed\r\nafter unsubscribe\r\n')
  })
})
