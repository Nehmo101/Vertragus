import { describe, expect, it, vi } from 'vitest'
import {
  armPiPlaySmoke,
  judgePiPlayScrollback,
  PI_PLAY_SMOKE_ENV,
  runPiPlaySmoke
} from './piPlaySmoke'

vi.mock('electron', () => ({
  app: { exit: vi.fn(), setPath: vi.fn() }
}))

const TUI = '\x1b[?2004h'
const MCP_OK = 'servers connected (12 tools)'
const MCP_FAIL = 'Failed to connect to vertragus'

describe('judgePiPlayScrollback', () => {
  it('waits on an empty PTY — the Windows blank-window signature until timeout', () => {
    expect(judgePiPlayScrollback('')).toEqual({ status: 'wait', reason: 'PTY still empty' })
  })

  it('fails when the adapter cannot reach Vertragus', () => {
    expect(judgePiPlayScrollback(`${TUI}\n${MCP_FAIL}`).status).toBe('fail')
    expect(judgePiPlayScrollback(MCP_FAIL).reason).toMatch(/failed to connect/i)
  })

  it('passes when the TUI started and MCP attached', () => {
    const judgement = judgePiPlayScrollback(`${TUI}\n${MCP_OK}`)
    expect(judgement.status).toBe('pass')
    expect(judgement.reason).toMatch(/MCP attached/)
  })

  it('treats No API key found as noise, not a verdict', () => {
    expect(judgePiPlayScrollback('No API key found for anthropic.')).toEqual({
      status: 'wait',
      reason: 'waiting for TUI (DECSET 2004) and MCP attach'
    })
    expect(judgePiPlayScrollback(`${TUI}\nNo API key found\n${MCP_OK}`).status).toBe('pass')
  })

  it('waits after TUI until MCP settles', () => {
    expect(judgePiPlayScrollback(TUI).status).toBe('wait')
  })

  it('waits when MCP attached but the TUI never started', () => {
    expect(judgePiPlayScrollback(MCP_OK).status).toBe('wait')
  })
})

describe('runPiPlaySmoke', () => {
  it('exits 0 and writes the log on pass', async () => {
    const exit = vi.fn()
    const writeLog = vi.fn(async () => undefined)
    await runPiPlaySmoke({
      logPath: '/tmp/pi-play.log',
      snapshot: () => `${TUI}\n${MCP_OK}`,
      writeLog,
      exit
    })
    expect(exit).toHaveBeenCalledWith(0)
    expect(writeLog).toHaveBeenCalledWith(
      '/tmp/pi-play.log',
      expect.stringMatching(/^status=pass$/m)
    )
  })

  it('fails when the PTY dies with no TUI', async () => {
    const exit = vi.fn()
    await runPiPlaySmoke({
      logPath: '/tmp/pi-play.log',
      snapshot: () => '',
      alive: () => false,
      writeLog: async () => undefined,
      exit
    })
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('fails when the workspace never started', async () => {
    const exit = vi.fn()
    await runPiPlaySmoke({
      logPath: '/tmp/pi-play.log',
      snapshot: () => 'should-not-matter',
      failedToStart: true,
      writeLog: async () => undefined,
      exit
    })
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('fails when the adapter cannot reach Vertragus', async () => {
    const exit = vi.fn()
    await runPiPlaySmoke({
      logPath: '/tmp/pi-play.log',
      snapshot: () => MCP_FAIL,
      writeLog: async () => undefined,
      exit
    })
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('still exits when the log cannot be written', async () => {
    const exit = vi.fn()
    const log = vi.fn()
    await runPiPlaySmoke({
      logPath: '/tmp/pi-play.log',
      snapshot: () => `${TUI}\n${MCP_OK}`,
      writeLog: async () => {
        throw new Error('disk full')
      },
      exit,
      log
    })
    expect(exit).toHaveBeenCalledWith(0)
    expect(log.mock.calls.flat().join('\n')).toMatch(/could not write log/)
  })

  it('times out while still waiting', async () => {
    const exit = vi.fn()
    let t = 0
    await runPiPlaySmoke({
      logPath: '/tmp/pi-play.log',
      snapshot: () => TUI,
      timeoutMs: 10,
      pollMs: 1,
      now: () => t,
      wait: async () => {
        t = 20
      },
      writeLog: async () => undefined,
      exit
    })
    expect(exit).toHaveBeenCalledWith(1)
  })
})

describe('armPiPlaySmoke', () => {
  it('is a no-op without VERTRAGUS_PI_PLAY_SMOKE', () => {
    const exit = vi.fn()
    armPiPlaySmoke({ snapshot: () => '', exit }, {})
    expect(exit).not.toHaveBeenCalled()
  })

  it('starts the loop when the env names a log path', async () => {
    const exit = vi.fn()
    armPiPlaySmoke(
      {
        snapshot: () => `${TUI}\n${MCP_OK}`,
        writeLog: async () => undefined,
        exit
      },
      { [PI_PLAY_SMOKE_ENV]: '/tmp/pi-play.log' }
    )
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
  })
})
