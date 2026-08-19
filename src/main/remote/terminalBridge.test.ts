import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { TerminalDirectory, TerminalSink, TerminalSubscription } from '@main/ipc'
import type { ServerMessage } from '@shared/remote/protocol'
import { createTerminalBridge } from './terminalBridge'

/** A fake TerminalDirectory backed by controllable sinks. */
function fakeTerminals(): {
  directory: TerminalDirectory
  emit(agentId: string, data: string): void
  exit(agentId: string, code: number): void
  writes: Array<{ agentId: string; data: string }>
  detached: string[]
} {
  const sinks = new Map<string, TerminalSink>()
  const writes: Array<{ agentId: string; data: string }> = []
  const detached: string[] = []
  const directory: TerminalDirectory = {
    list: () => [],
    get: () => undefined,
    attach: (agentId, sink): TerminalSubscription | undefined => {
      if (agentId === 'ghost') return undefined
      sinks.set(agentId, sink)
      return {
        snapshot: `snapshot:${agentId}`,
        cols: 80,
        rows: 24,
        meta: {
          agentId,
          name: `Name-${agentId}`,
          role: 'worker',
          roleColor: '#123456',
          provider: 'claude',
          model: 'sonnet'
        },
        exit: null,
        detach: () => {
          sinks.delete(agentId)
          detached.push(agentId)
        }
      }
    },
    write: (agentId, data) => {
      writes.push({ agentId, data })
      return true
    },
    resize: () => true
  }
  return {
    directory,
    emit: (agentId, data) => sinks.get(agentId)?.onData(data),
    exit: (agentId, code) => sinks.get(agentId)?.onExit({ exitCode: code }),
    writes,
    detached
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('createTerminalBridge', () => {
  it('sends a snapshot on attach, then coalesced data', () => {
    const term = fakeTerminals()
    const sent: ServerMessage[] = []
    const bridge = createTerminalBridge({ terminals: term.directory, send: (m) => sent.push(m), coalesceMs: 16 })

    bridge.attach('a1')
    expect(sent[0]).toMatchObject({ type: 'snapshot', agentId: 'a1', snapshot: 'snapshot:a1', name: 'Name-a1' })

    term.emit('a1', 'chunk-1')
    term.emit('a1', 'chunk-2')
    // Nothing sent yet — still within the coalesce window.
    expect(sent.filter((m) => m.type === 'data')).toHaveLength(0)
    vi.advanceTimersByTime(16)
    expect(sent.filter((m) => m.type === 'data')).toEqual([
      { type: 'data', agentId: 'a1', data: 'chunk-1chunk-2' }
    ])
  })

  it('reports an unknown agent as an error, not a snapshot', () => {
    const term = fakeTerminals()
    const sent: ServerMessage[] = []
    const bridge = createTerminalBridge({ terminals: term.directory, send: (m) => sent.push(m) })
    bridge.attach('ghost')
    expect(sent).toEqual([{ type: 'error', message: 'unknown agent ghost' }])
  })

  it('flushes pending data before an exit message', () => {
    const term = fakeTerminals()
    const sent: ServerMessage[] = []
    const bridge = createTerminalBridge({ terminals: term.directory, send: (m) => sent.push(m) })
    bridge.attach('a1')
    term.emit('a1', 'last-bytes')
    term.exit('a1', 137)
    const tail = sent.slice(-2)
    expect(tail).toEqual([
      { type: 'data', agentId: 'a1', data: 'last-bytes' },
      { type: 'exit', agentId: 'a1', exitCode: 137 }
    ])
  })

  it('only forwards input for an attached agent', () => {
    const term = fakeTerminals()
    const bridge = createTerminalBridge({ terminals: term.directory, send: () => undefined })
    bridge.input('a1', 'ignored — not attached')
    bridge.attach('a1')
    bridge.input('a1', 'ls\r')
    expect(term.writes).toEqual([{ agentId: 'a1', data: 'ls\r' }])
  })

  it('detaches subscriptions on dispose', () => {
    const term = fakeTerminals()
    const bridge = createTerminalBridge({ terminals: term.directory, send: () => undefined })
    bridge.attach('a1')
    bridge.attach('a2')
    bridge.dispose()
    expect(term.detached.sort()).toEqual(['a1', 'a2'])
  })

  it('is idempotent on a double attach', () => {
    const term = fakeTerminals()
    const sent: ServerMessage[] = []
    const bridge = createTerminalBridge({ terminals: term.directory, send: (m) => sent.push(m) })
    bridge.attach('a1')
    bridge.attach('a1')
    expect(sent.filter((m) => m.type === 'snapshot')).toHaveLength(1)
  })

  it('drops the attachment on exit so a later input is ignored, not written to a dead pty', () => {
    const term = fakeTerminals()
    const bridge = createTerminalBridge({ terminals: term.directory, send: () => undefined })
    bridge.attach('a1')
    term.exit('a1', 0)
    // The subscription was detached, and input after exit goes nowhere.
    expect(term.detached).toContain('a1')
    bridge.input('a1', 'too late')
    expect(term.writes).toHaveLength(0)
  })

  it('force-flushes when a burst exceeds the pending cap within one window', () => {
    const term = fakeTerminals()
    const sent: ServerMessage[] = []
    const bridge = createTerminalBridge({ terminals: term.directory, send: (m) => sent.push(m), coalesceMs: 1_000 })
    bridge.attach('a1')
    // A single chunk over the 256 KiB cap forces an immediate flush — no timer,
    // no unbounded growth inside the coalesce window.
    term.emit('a1', 'x'.repeat(300 * 1024))
    expect(sent.filter((m) => m.type === 'data')).toHaveLength(1)
  })
})
