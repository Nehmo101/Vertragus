import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type ExitHandler = (event: { exitCode: number; signal?: number }) => void
type DataHandler = (data: string) => void

const mocks = vi.hoisted(() => ({
  ptySpawn: vi.fn(),
  closePaneWindows: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: () => '.' }
}))
vi.mock('@lydell/node-pty', () => ({ spawn: mocks.ptySpawn }))
vi.mock('@main/windows', () => ({ closePaneWindows: mocks.closePaneWindows }))
vi.mock('@main/config/store', () => ({
  getProfile: () => undefined,
  getSetting: () => undefined,
  listMcpServers: () => []
}))
vi.mock('@main/agents/worktree', () => ({
  createWorktree: vi.fn().mockResolvedValue(undefined),
  currentBranch: vi.fn().mockResolvedValue('main'),
  rollbackWorktree: vi.fn().mockResolvedValue(true)
}))
vi.mock('@main/agents/resolveCommand', () => ({
  resolveLaunch: vi.fn(async (command: string, args: string[]) => ({ file: command, args }))
}))

import { AgentManager } from './AgentManager'

interface FakePty {
  emitData(data: string): void
  emitExit(event: { exitCode: number; signal?: number }): void
}

interface EmittedChunk {
  id: string
  data: string
  seq: number
}

async function spawnAgent(manager: AgentManager): Promise<string> {
  const info = await manager.spawn({ provider: 'codex', model: '', kind: 'sub', workingDir: '.' })
  expect(info.status).toBe('running')
  return info.id
}

describe('AgentManager PTY data micro-batching', () => {
  const processes: FakePty[] = []

  beforeEach(() => {
    processes.length = 0
    mocks.ptySpawn.mockReset()
    mocks.closePaneWindows.mockReset()
    mocks.ptySpawn.mockImplementation(() => {
      const exitHandlers: ExitHandler[] = []
      const dataHandlers: DataHandler[] = []
      const proc = {
        pid: 500 + processes.length,
        onData: vi.fn((handler: DataHandler) => {
          dataHandlers.push(handler)
        }),
        onExit: vi.fn((handler: ExitHandler) => {
          exitHandlers.push(handler)
        }),
        kill: vi.fn(() => {
          for (const handler of [...exitHandlers]) handler({ exitCode: 0 })
        }),
        resize: vi.fn(),
        write: vi.fn()
      }
      processes.push({
        emitData: (data) => {
          for (const handler of dataHandlers) handler(data)
        },
        emitExit: (event) => {
          for (const handler of exitHandlers) handler(event)
        }
      })
      return proc
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('coalesces rapid PTY chunks into one ordered data emit per interval', async () => {
    const manager = new AgentManager()
    const emitted: EmittedChunk[] = []
    manager.on('data', (chunk: EmittedChunk) => emitted.push(chunk))
    const id = await spawnAgent(manager)
    vi.useFakeTimers()

    processes[0]!.emitData('erste ')
    processes[0]!.emitData('zweite ')
    processes[0]!.emitData('dritte')

    // Mid-batch the stream stays consistent: nothing emitted yet, and a
    // buffer() replay snapshot matches its seq (no duplicate on catch-up).
    expect(emitted).toEqual([])
    expect(manager.buffer(id)).toEqual({ data: '', seq: 0 })

    vi.advanceTimersByTime(16)

    expect(emitted).toEqual([{ id, data: 'erste zweite dritte', seq: 1 }])
    expect(manager.buffer(id)).toEqual({ data: 'erste zweite dritte', seq: 1 })
  })

  it('keeps batches per agent — chunks of different agents never merge', async () => {
    const manager = new AgentManager()
    const emitted: EmittedChunk[] = []
    manager.on('data', (chunk: EmittedChunk) => emitted.push(chunk))
    const first = await spawnAgent(manager)
    const second = await spawnAgent(manager)
    vi.useFakeTimers()

    processes[0]!.emitData('A1')
    processes[1]!.emitData('B1')
    processes[0]!.emitData('A2')
    vi.advanceTimersByTime(16)

    expect(emitted).toEqual([
      { id: first, data: 'A1A2', seq: 1 },
      { id: second, data: 'B1', seq: 1 }
    ])
  })

  it('flushes the pending batch immediately on PTY exit so final lines survive', async () => {
    const manager = new AgentManager()
    const emitted: EmittedChunk[] = []
    manager.on('data', (chunk: EmittedChunk) => emitted.push(chunk))
    const id = await spawnAgent(manager)
    vi.useFakeTimers()

    processes[0]!.emitData('letzte Zeile')
    processes[0]!.emitExit({ exitCode: 0 })

    // No timer advanced — the exit path itself delivered the batch before the
    // exit status was announced.
    expect(emitted).toEqual([{ id, data: 'letzte Zeile', seq: 1 }])
    expect(manager.buffer(id).data).toContain('letzte Zeile')
    expect(manager.list().find((agent) => agent.id === id)?.status).toBe('stopped')
  })

  it('flushes pending output when the agent is killed', async () => {
    const manager = new AgentManager()
    const emitted: EmittedChunk[] = []
    manager.on('data', (chunk: EmittedChunk) => emitted.push(chunk))
    const id = await spawnAgent(manager)
    vi.useFakeTimers()

    processes[0]!.emitData('ungespeicherter Rest')
    await manager.kill(id)

    expect(emitted[0]).toEqual({ id, data: 'ungespeicherter Rest', seq: 1 })
    expect(manager.list()).toEqual([])
  })
})
