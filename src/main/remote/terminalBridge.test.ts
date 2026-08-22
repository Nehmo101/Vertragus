import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { TerminalDirectory, TerminalSink, TerminalSubscription } from '@main/ipc'
import type { ServerMessage } from '@shared/remote/protocol'
import { SCROLLBACK_LIMIT } from '@main/agents/scrollback'
import { MAX_RESUME_TAIL_CHARS } from '@shared/remote/protocol'
import { createTerminalBridge, resumeSnapshot } from './terminalBridge'
/*
 * The client's own aligner, imported rather than restated. What this file has
 * to prove is not that `resumeSnapshot` slices correctly — it is that what it
 * produces can still be placed by the code on the other end of the wire, and a
 * reimplementation of that code here would prove nothing about it.
 */
import {
  OVERLAP_TAIL_CHARS,
  planAttach,
  trackWritten
} from '../../remoteClient/terminalAttach'

/** A fake TerminalDirectory backed by controllable sinks. */
function fakeTerminals(scrollback?: (agentId: string) => string): {
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
        snapshot: scrollback ? scrollback(agentId) : `snapshot:${agentId}`,
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

/** A long, non-repeating stream — a scrollback nothing can match by accident. */
function stream(from: number, lines: number): string {
  let out = ''
  for (let i = from; i < from + lines; i++) out += `line ${i} of the agent's output\n`
  return out
}

describe('resumeSnapshot', () => {
  it('replays everything when the client offers nothing', () => {
    // A first attach, and every attach from a client that predates the marker.
    expect(resumeSnapshot('abcdef', undefined)).toBe('abcdef')
    expect(resumeSnapshot('abcdef', '')).toBe('abcdef')
  })

  it('replays everything when the marker is not there any more', () => {
    // The head-trim in `ScrollbackBuffer` drops the oldest characters, so a
    // client that was away longer than the buffer is deep has a marker that
    // points at output the host no longer holds. That is the case the whole
    // scheme has to survive, and surviving it means the full replay it always
    // did — the client then finds nothing to align on and rebuilds, exactly as
    // it would have without any of this.
    expect(resumeSnapshot('ghijkl', 'abc')).toBe('ghijkl')
  })

  it('replays everything when the marker is longer than the scrollback', () => {
    // A restarted agent: a fresh, nearly empty buffer under an old marker.
    expect(resumeSnapshot('abc', 'abcdef')).toBe('abc')
  })

  it('starts the reply at the marker rather than after it', () => {
    // The echo is the safety: the frame still contains the client's own tail,
    // so the client aligns on it exactly as it aligns on a full snapshot.
    expect(resumeSnapshot('....MARKER++++', 'MARKER')).toBe('MARKER++++')
  })

  it('resumes from the most recent occurrence of a repeated marker', () => {
    // Our position in the stream is the LAST place our tail appears; an
    // earlier one would re-send output the reader has already seen.
    expect(resumeSnapshot('MARKERaaaMARKERbbb', 'MARKER')).toBe('MARKERbbb')
  })

  it('replays everything when the marker is already at the head', () => {
    // Nothing to trim — the client has the whole buffer.
    expect(resumeSnapshot('MARKER+++', 'MARKER')).toBe('MARKER+++')
  })
})

describe('a resumed snapshot is still alignable by the client', () => {
  /** A scrollback at the host's real limit — the bill this is about. */
  const seen = stream(0, 65_000).slice(-SCROLLBACK_LIMIT)
  const delta = stream(90_000, 5)

  it('is built on a stream long enough for the test to mean anything', () => {
    // Self-check: with a stream shorter than the marker there is nothing to
    // trim and every assertion below would pass vacuously.
    expect(seen.length).toBe(SCROLLBACK_LIMIT)
  })

  it('hands back only what the client is missing, and it lands as an append', () => {
    // The two tails one reconnect involves: the connection layer offers the
    // longer one as the marker, the terminal aligns on the shorter one.
    const marker = trackWritten('', seen, MAX_RESUME_TAIL_CHARS)
    const written = trackWritten('', seen, OVERLAP_TAIL_CHARS)

    const frame = resumeSnapshot(seen + delta, marker)
    expect(frame).toBe(marker + delta)
    // The number the change exists for: a full scrollback costs 2,000,000
    // characters on every reconnect, and this reconnect costs under 1 % of it.
    expect(frame.length).toBeLessThan(seen.length / 100)

    const plan = planAttach({ snapshot: frame, written })
    expect(plan.kind).toBe('append')
    // Exactly the new output: not a byte re-written, not a byte lost.
    expect(plan.data).toBe(delta)
  })

  it('appends nothing at all when nothing happened while the client was away', () => {
    const marker = trackWritten('', seen, MAX_RESUME_TAIL_CHARS)
    const plan = planAttach({ snapshot: resumeSnapshot(seen, marker), written: marker })
    expect(plan.kind).toBe('append')
    expect(plan.data).toBe('')
  })

  it('falls back to the replay it always did when the marker is gone', () => {
    // The host trimmed past the client's marker. The bridge replays in full and
    // the client rebuilds from it — the pre-marker behaviour, reached by the
    // pre-marker path.
    const trimmed = stream(200_000, 2000)
    const marker = trackWritten('', seen, MAX_RESUME_TAIL_CHARS)
    const frame = resumeSnapshot(trimmed, marker)
    expect(frame).toBe(trimmed)
    const plan = planAttach({ snapshot: frame, written: marker })
    expect(plan.kind).toBe('replay')
    expect(plan.data).toBe(trimmed)
  })
})

describe('the bridge carries the marker into the snapshot it sends', () => {
  it('trims the replay to what the attaching client asked for', () => {
    const seen = stream(0, 2000)
    const delta = stream(2000, 5)
    const term = fakeTerminals(() => seen + delta)
    const sent: ServerMessage[] = []
    const bridge = createTerminalBridge({ terminals: term.directory, send: (m) => sent.push(m) })

    const marker = trackWritten('', seen, MAX_RESUME_TAIL_CHARS)
    bridge.attach('a1', marker)

    const snapshot = sent.find((m) => m.type === 'snapshot')
    expect(snapshot?.type).toBe('snapshot')
    expect(snapshot?.type === 'snapshot' && snapshot.snapshot).toBe(marker + delta)
    bridge.dispose()
  })

  it('sends the whole scrollback to a client that asks for nothing', () => {
    const whole = stream(0, 2000)
    const term = fakeTerminals(() => whole)
    const sent: ServerMessage[] = []
    const bridge = createTerminalBridge({ terminals: term.directory, send: (m) => sent.push(m) })

    bridge.attach('a1')

    const snapshot = sent.find((m) => m.type === 'snapshot')
    expect(snapshot?.type === 'snapshot' && snapshot.snapshot).toBe(whole)
    bridge.dispose()
  })
})
