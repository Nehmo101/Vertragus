import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The production wiring at the bottom of ipc.ts pulls in Electron and the CLI
// window registry; the contract under test is createTerminalIpc, which takes
// its host as an argument.
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }))
vi.mock('./windows/cliWindow', () => ({
  isCliWindowSender: vi.fn(() => null),
  getCliWindow: vi.fn(() => null),
  closeCliWindow: vi.fn()
}))

import {
  createTerminalIpc,
  setTerminalInputSink,
  TERMINAL_CHANNELS,
  TERMINAL_COALESCE_MS,
  type AgentMeta,
  type AgentRegistry,
  type MinimalIpcMain,
  type TerminalAttachResult
} from './ipc'
import type { PtyAgentLike, PtyExitInfo } from './agents/PtyAgent'

type Listener = (event: { sender: { id: number } }, ...args: never[]) => unknown

class FakeIpcMain implements MinimalIpcMain {
  readonly handlers = new Map<string, Listener>()
  readonly listeners = new Map<string, Listener>()

  handle(channel: string, listener: Listener): void {
    this.handlers.set(channel, listener)
  }
  on(channel: string, listener: Listener): void {
    this.listeners.set(channel, listener)
  }
  removeHandler(channel: string): void {
    this.handlers.delete(channel)
  }
  removeAllListeners(channel: string): void {
    this.listeners.delete(channel)
  }

  invoke(channel: string, webContentsId: number, ...args: unknown[]): unknown {
    const handler = this.handlers.get(channel)
    if (!handler) throw new Error(`no handler for ${channel}`)
    return handler({ sender: { id: webContentsId } }, ...(args as never[]))
  }
  send(channel: string, webContentsId: number, ...args: unknown[]): void {
    this.listeners.get(channel)?.({ sender: { id: webContentsId } }, ...(args as never[]))
  }
}

class FakePty implements PtyAgentLike {
  pid: number | undefined = 1234
  isAlive = true
  cols = 100
  rows = 30
  readonly written: string[] = []
  readonly resizes: [number, number][] = []
  killed = 0
  private buffer = ''
  private readonly dataListeners = new Set<(data: string) => void>()
  private readonly exitListeners = new Set<(info: PtyExitInfo) => void>()

  write(data: string): void {
    this.written.push(data)
  }
  resize(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows
    this.resizes.push([cols, rows])
  }
  onData(listener: (data: string) => void): () => void {
    this.dataListeners.add(listener)
    return () => this.dataListeners.delete(listener)
  }
  onExit(listener: (info: PtyExitInfo) => void): () => void {
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }
  snapshot(): string {
    return this.buffer
  }
  kill(): void {
    this.killed += 1
  }

  emitData(data: string): void {
    this.buffer += data
    for (const listener of [...this.dataListeners]) listener(data)
  }
  emitExit(info: PtyExitInfo): void {
    this.isAlive = false
    for (const listener of [...this.exitListeners]) listener(info)
  }
  get dataListenerCount(): number {
    return this.dataListeners.size
  }
}

function meta(agentId: string, name = 'Caronte'): AgentMeta {
  return {
    agentId,
    name,
    role: 'worker',
    roleColor: '#2f7d6d',
    provider: 'claude',
    model: 'sonnet'
  }
}

/** webContents id → agentId, exactly like the CLI window registry does. */
const WINDOWS: Record<number, string> = { 10: 'agent-a', 20: 'agent-b' }
const PANEL_WEBCONTENTS_ID = 99

let ipc: FakeIpcMain
let sent: { agentId: string; channel: string; payload: unknown }[]
let closed: string[]
let minimized: string[]
/** agentId → "fills its screen", the state the fake window layer keeps. */
let maximized: Set<string>
let registry: AgentRegistry
let ptyA: FakePty
let ptyB: FakePty
let liveWindows: Set<string>

beforeEach(() => {
  vi.useFakeTimers()
  ipc = new FakeIpcMain()
  sent = []
  closed = []
  minimized = []
  maximized = new Set()
  liveWindows = new Set(Object.values(WINDOWS))
  registry = createTerminalIpc({
    ipcMain: ipc,
    senderAgentId: (id) => WINDOWS[id] ?? null,
    hasWindow: (agentId) => liveWindows.has(agentId),
    send: (agentId, channel, payload) => sent.push({ agentId, channel, payload }),
    closeWindow: (agentId) => closed.push(agentId),
    minimizeWindow: (agentId) => minimized.push(agentId),
    toggleMaximizeWindow: (agentId) => {
      if (maximized.delete(agentId)) return false
      maximized.add(agentId)
      return true
    },
    isWindowMaximized: (agentId) => maximized.has(agentId)
  })
  ptyA = new FakePty()
  ptyB = new FakePty()
  registry.registerAgent({ pty: ptyA, meta: meta('agent-a') })
  registry.registerAgent({ pty: ptyB, meta: meta('agent-b', 'Colombina') })
})

afterEach(() => {
  setTerminalInputSink(undefined)
  registry.dispose()
  vi.useRealTimers()
})

function attach(webContentsId: number, agentId?: string): TerminalAttachResult {
  return ipc.invoke(
    TERMINAL_CHANNELS.attach,
    webContentsId,
    agentId ? { agentId } : undefined
  ) as TerminalAttachResult
}

describe('terminal:attach', () => {
  it('replays the scrollback with geometry and agent metadata', () => {
    ptyA.emitData('boot line\r\n')
    const result = attach(10, 'agent-a')

    expect(result.snapshot).toBe('boot line\r\n')
    expect(result.cols).toBe(100)
    expect(result.rows).toBe(30)
    expect(result.meta).toEqual(meta('agent-a'))
    expect(result.exit).toBeNull()
  })

  it('reports an exit that happened before the window attached', () => {
    ptyA.emitExit({ exitCode: 3 })
    expect(attach(10).exit).toEqual({ exitCode: 3 })
  })

  it('rejects a window that is not a CLI window (the panel)', () => {
    expect(() => attach(PANEL_WEBCONTENTS_ID)).toThrow(/not a CLI window/)
  })

  it('rejects a CLI window asking for a foreign agent', () => {
    expect(() => attach(20, 'agent-a')).toThrow(/its own agent/)
    expect(() => attach(10, 'agent-b')).toThrow(/its own agent/)
  })

  it('rejects a window whose agent is not registered', () => {
    registry.removeAgent('agent-a')
    expect(() => attach(10)).toThrow(/unknown agent/)
  })
})

describe('terminal:input and terminal:resize', () => {
  it('types into the sender’s own PTY', () => {
    ipc.send(TERMINAL_CHANNELS.input, 10, 'ls\r')
    expect(ptyA.written).toEqual(['ls\r'])
    expect(ptyB.written).toEqual([])
  })

  it('ignores input from a window that is not a CLI window', () => {
    ipc.send(TERMINAL_CHANNELS.input, PANEL_WEBCONTENTS_ID, 'rm -rf /\r')
    expect(ptyA.written).toEqual([])
    expect(ptyB.written).toEqual([])
  })

  it('ignores non-string payloads', () => {
    ipc.send(TERMINAL_CHANNELS.input, 10, { toString: () => 'nope' })
    ipc.send(TERMINAL_CHANNELS.input, 10, '')
    expect(ptyA.written).toEqual([])
  })

  it('invokes the input sink with agentId and data after writing the PTY', () => {
    const seen: Array<[string, string]> = []
    setTerminalInputSink((agentId, data) => {
      seen.push([agentId, data])
    })
    ipc.send(TERMINAL_CHANNELS.input, 10, 'ls\r')
    expect(ptyA.written).toEqual(['ls\r'])
    expect(seen).toEqual([['agent-a', 'ls\r']])
  })

  it('invokes the sink for any agent — the sink decides orchestrator vs not', () => {
    const seen: string[] = []
    setTerminalInputSink((agentId) => {
      seen.push(agentId)
    })
    ipc.send(TERMINAL_CHANNELS.input, 10, 'a')
    ipc.send(TERMINAL_CHANNELS.input, 20, 'b')
    expect(seen).toEqual(['agent-a', 'agent-b'])
    expect(ptyA.written).toEqual(['a'])
    expect(ptyB.written).toEqual(['b'])
  })

  it('writes the PTY even when no sink is attached', () => {
    setTerminalInputSink(undefined)
    ipc.send(TERMINAL_CHANNELS.input, 10, 'x')
    expect(ptyA.written).toEqual(['x'])
  })

  it('fires the same sink from TerminalDirectory.write (remote steering)', () => {
    const seen: Array<[string, string]> = []
    setTerminalInputSink((agentId, data) => {
      seen.push([agentId, data])
    })
    expect(registry.terminals().write('agent-a', 'from the phone\r')).toBe(true)
    expect(ptyA.written).toEqual(['from the phone\r'])
    expect(seen).toEqual([['agent-a', 'from the phone\r']])
  })

  it('does not fire the sink for a direct pty.write (seed / sendToAgent / assignGoal)', () => {
    const seen: string[] = []
    setTerminalInputSink((_agentId, data) => {
      seen.push(data)
    })
    ptyA.write('seeded goal\r')
    expect(seen).toEqual([])
    expect(ptyA.written).toEqual(['seeded goal\r'])
  })

  it('forwards a valid resize and drops nonsense', () => {
    ipc.send(TERMINAL_CHANNELS.resize, 10, { cols: 120, rows: 40 })
    ipc.send(TERMINAL_CHANNELS.resize, 10, { cols: 0, rows: 40 })
    ipc.send(TERMINAL_CHANNELS.resize, 10, { cols: Number.NaN, rows: 40 })
    ipc.send(TERMINAL_CHANNELS.resize, 10, {})
    ipc.send(TERMINAL_CHANNELS.resize, PANEL_WEBCONTENTS_ID, { cols: 200, rows: 60 })

    expect(ptyA.resizes).toEqual([[120, 40]])
    expect(ptyB.resizes).toEqual([])
  })
})

describe('terminal:data coalescing', () => {
  it('merges a burst into a single frame-sized delivery', () => {
    attach(10)
    ptyA.emitData('a')
    ptyA.emitData('b')
    ptyA.emitData('c')
    expect(sent).toHaveLength(0)

    vi.advanceTimersByTime(TERMINAL_COALESCE_MS)

    expect(sent).toEqual([
      { agentId: 'agent-a', channel: TERMINAL_CHANNELS.data, payload: { agentId: 'agent-a', data: 'abc' } }
    ])
  })

  it('starts a new frame after the previous one flushed', () => {
    attach(10)
    ptyA.emitData('one')
    vi.advanceTimersByTime(TERMINAL_COALESCE_MS)
    ptyA.emitData('two')
    vi.advanceTimersByTime(TERMINAL_COALESCE_MS)

    expect(sent.map((event) => (event.payload as { data: string }).data)).toEqual(['one', 'two'])
  })

  it('never sends before attach — the snapshot carries that output instead', () => {
    ptyA.emitData('early output')
    vi.advanceTimersByTime(TERMINAL_COALESCE_MS * 4)
    expect(sent).toHaveLength(0)

    const result = attach(10)
    expect(result.snapshot).toBe('early output')
    vi.advanceTimersByTime(TERMINAL_COALESCE_MS * 4)
    // No duplicate of the snapshotted bytes after attach.
    expect(sent).toHaveLength(0)
  })

  it('keeps each agent on its own channel target', () => {
    attach(10)
    attach(20)
    ptyA.emitData('for-a')
    ptyB.emitData('for-b')
    vi.advanceTimersByTime(TERMINAL_COALESCE_MS)

    expect(sent).toEqual([
      { agentId: 'agent-a', channel: TERMINAL_CHANNELS.data, payload: { agentId: 'agent-a', data: 'for-a' } },
      { agentId: 'agent-b', channel: TERMINAL_CHANNELS.data, payload: { agentId: 'agent-b', data: 'for-b' } }
    ])
  })
})

describe('terminal:exit', () => {
  it('flushes pending output before announcing the exit code', () => {
    attach(10)
    ptyA.emitData('last words\r\n')
    ptyA.emitExit({ exitCode: 1, signal: 15 })

    expect(sent).toEqual([
      {
        agentId: 'agent-a',
        channel: TERMINAL_CHANNELS.data,
        payload: { agentId: 'agent-a', data: 'last words\r\n' }
      },
      {
        agentId: 'agent-a',
        channel: TERMINAL_CHANNELS.exit,
        payload: { agentId: 'agent-a', exitCode: 1, signal: 15 }
      }
    ])
  })

  it('stays quiet when no window is attached', () => {
    ptyA.emitExit({ exitCode: 0 })
    expect(sent).toHaveLength(0)
  })
})

describe('window:close', () => {
  it('closes only the window and stops the stream, leaving the agent registered', () => {
    attach(10)
    ipc.send(TERMINAL_CHANNELS.windowClose, 10)

    expect(closed).toEqual(['agent-a'])
    expect(registry.getAgent('agent-a')).toBeDefined()
    expect(ptyA.killed).toBe(0)

    ptyA.emitData('still running')
    vi.advanceTimersByTime(TERMINAL_COALESCE_MS * 4)
    expect(sent).toHaveLength(0)
    // …and it is all still there for the next attach.
    expect(attach(10).snapshot).toBe('still running')
  })

  it('stops streaming when the window vanished without a close message', () => {
    attach(10)
    liveWindows.delete('agent-a')
    ptyA.emitData('into the void')
    vi.advanceTimersByTime(TERMINAL_COALESCE_MS)
    expect(sent).toHaveLength(0)

    // The next attach picks everything up from the scrollback again.
    liveWindows.add('agent-a')
    expect(attach(10).snapshot).toBe('into the void')
  })

  it('ignores a close from a window that is not a CLI window', () => {
    ipc.send(TERMINAL_CHANNELS.windowClose, PANEL_WEBCONTENTS_ID)
    expect(closed).toEqual([])
  })
})

describe('window:minimize', () => {
  it('minimizes only the sender’s own window', () => {
    ipc.send(TERMINAL_CHANNELS.windowMinimize, 10)
    expect(minimized).toEqual(['agent-a'])
  })

  it('ignores a minimize from a window that is not a CLI window', () => {
    ipc.send(TERMINAL_CHANNELS.windowMinimize, PANEL_WEBCONTENTS_ID)
    expect(minimized).toEqual([])
  })
})

describe('window:maximize', () => {
  const toggle = (webContentsId: number): boolean =>
    ipc.invoke(TERMINAL_CHANNELS.windowMaximize, webContentsId) as boolean

  it('toggles only the sender’s own window and answers with the new state', () => {
    expect(toggle(10)).toBe(true)
    expect([...maximized]).toEqual(['agent-a'])
    expect(toggle(10)).toBe(false)
    expect([...maximized]).toEqual([])
  })

  it('ignores a toggle from a window that is not a CLI window', () => {
    expect(toggle(PANEL_WEBCONTENTS_ID)).toBe(false)
    expect([...maximized]).toEqual([])
  })

  it('reports the current state in the attach result', () => {
    expect(attach(10).maximized).toBe(false)
    toggle(10)
    // A reloaded renderer learns it is maximized without having clicked.
    expect(attach(10).maximized).toBe(true)
    expect(attach(20).maximized).toBe(false)
  })
})

describe('terminal:task', () => {
  it('rides on the attach result once a task note is set', () => {
    expect(attach(10).task).toBeUndefined()
    registry.setAgentTask('agent-a', 'Fix the parser')
    expect(attach(10).task).toBe('Fix the parser')
    expect(attach(20).task).toBeUndefined()
  })

  it('pushes a change to the attached window and dedupes repeats', () => {
    attach(10)
    registry.setAgentTask('agent-a', 'Fix the parser')
    registry.setAgentTask('agent-a', 'Fix the parser')

    expect(sent).toEqual([
      {
        agentId: 'agent-a',
        channel: TERMINAL_CHANNELS.task,
        payload: { agentId: 'agent-a', task: 'Fix the parser' }
      }
    ])
  })

  it('stays quiet for a detached window — the next attach carries the note', () => {
    registry.setAgentTask('agent-a', 'Fix the parser')
    expect(sent).toHaveLength(0)
    expect(attach(10).task).toBe('Fix the parser')
  })

  it('ignores unknown agents and survives a re-registration', () => {
    expect(() => registry.setAgentTask('ghost', 'nothing')).not.toThrow()
    registry.setAgentTask('agent-a', 'Fix the parser')
    // A PTY swap under the same id keeps the note, like the rest of the record.
    registry.registerAgent({ pty: new FakePty(), meta: meta('agent-a') })
    expect(attach(10).task).toBe('Fix the parser')
  })

  it('clears the note when the assignment is withdrawn', () => {
    attach(10)
    registry.setAgentTask('agent-a', 'Fix the parser')
    registry.setAgentTask('agent-a', undefined)

    expect(sent[1]).toEqual({
      agentId: 'agent-a',
      channel: TERMINAL_CHANNELS.task,
      payload: { agentId: 'agent-a' }
    })
    expect(attach(10).task).toBeUndefined()
  })
})

describe('AgentRegistry', () => {
  it('lists and looks up registered agents', () => {
    expect(registry.listAgents().map((entry) => entry.meta.agentId)).toEqual(['agent-a', 'agent-b'])
    expect(registry.getAgent('agent-a')?.meta.name).toBe('Caronte')
    expect(registry.getAgent('ghost')).toBeUndefined()
  })

  it('unsubscribes from the PTY when an agent is removed', () => {
    attach(10)
    expect(ptyA.dataListenerCount).toBe(1)
    registry.removeAgent('agent-a')

    expect(ptyA.dataListenerCount).toBe(0)
    ptyA.emitData('orphan')
    vi.advanceTimersByTime(TERMINAL_COALESCE_MS * 4)
    expect(sent).toHaveLength(0)
    expect(registry.listAgents()).toHaveLength(1)
  })

  it('replaces a re-registered agent without leaking the old subscription', () => {
    const replacement = new FakePty()
    registry.registerAgent({ pty: replacement, meta: meta('agent-a') })
    expect(ptyA.dataListenerCount).toBe(0)

    attach(10)
    ptyA.emitData('stale')
    replacement.emitData('fresh')
    vi.advanceTimersByTime(TERMINAL_COALESCE_MS)

    expect(sent.map((event) => (event.payload as { data: string }).data)).toEqual(['fresh'])
  })

  it('markDetached stops the stream until the next attach', () => {
    attach(10)
    registry.markDetached('agent-a')
    ptyA.emitData('unseen')
    vi.advanceTimersByTime(TERMINAL_COALESCE_MS * 4)
    expect(sent).toHaveLength(0)
    expect(() => registry.markDetached('ghost')).not.toThrow()
  })

  it('dispose clears the registry and the channel handlers', () => {
    registry.dispose()
    expect(registry.listAgents()).toEqual([])
    expect(ipc.handlers.size).toBe(0)
    expect(ipc.listeners.size).toBe(0)
  })
})

describe('preload channel parity', () => {
  it('uses exactly the channel names main registers', () => {
    // preload is bundled separately and cannot import main; this catches drift.
    const source = readFileSync(join(__dirname, '../preload/index.ts'), 'utf8')
    for (const channel of Object.values(TERMINAL_CHANNELS)) {
      expect(source).toContain(`'${channel}'`)
    }
    const preloadChannels = [...source.matchAll(/'(terminal:[a-z]+|window:[a-z]+)'/g)].map(
      (match) => match[1]
    )
    expect(new Set(preloadChannels)).toEqual(new Set(Object.values(TERMINAL_CHANNELS)))
  })
})
