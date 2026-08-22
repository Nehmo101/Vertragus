import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { TerminalDirectory, TerminalSink, TerminalSubscription } from '@main/ipc'
import type { ServerMessage } from '@shared/remote/protocol'
import { SCROLLBACK_LIMIT } from '@main/agents/scrollback'
import { MAX_RESUME_TAIL_CHARS } from '@shared/remote/protocol'
import {
  createTerminalBridge,
  lastIndexOfFrom,
  MAX_RESUME_DELTA_CHARS,
  resumeSnapshot
} from './terminalBridge'
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

/*
 * The cost of the search, pinned as a property rather than as a stopwatch.
 *
 * `resumeSnapshot` runs in the Electron main process, synchronously, on an
 * `attach` frame whose two operands the client controls: `bridge.input` writes
 * to a real PTY, so the scrollback is as forgeable as the marker. With an
 * unbounded naive search that is a 15-second freeze of every window, every IPC
 * channel and every parked orchestrator await, from one frame, repeatable as
 * fast as attach/detach can be cycled. A wall-clock assertion would only say
 * that this machine was fast today, so the two halves of the bound are asserted
 * for what they are: how much of the snapshot the search may touch, and how
 * many times it may touch each character of it.
 */
describe('the resume search is bounded, not the whole scrollback', () => {
  const head = 'HEAD'
  const marker = `MARK${'m'.repeat(60)}`
  /** The marker sits exactly ON the far edge of the window. */
  const atEdge = head + marker + 'x'.repeat(MAX_RESUME_DELTA_CHARS)
  /** ... and one character further back than it, which is out of reach. */
  const beyondEdge = head + marker + 'x'.repeat(MAX_RESUME_DELTA_CHARS + 1)

  it('is built on snapshots that really do contain the marker', () => {
    // Self-check for the two assertions below: if the marker were absent, or
    // sat somewhere other than where the arithmetic says, "returns the whole
    // snapshot" would prove nothing about where the search looked.
    expect(atEdge.lastIndexOf(marker)).toBe(head.length)
    expect(beyondEdge.lastIndexOf(marker)).toBe(head.length)
    expect(beyondEdge.length - atEdge.length).toBe(1)
    // And the window is the thing under test, so it must be smaller than the
    // buffer it is a window into.
    expect(MAX_RESUME_DELTA_CHARS).toBeLessThan(SCROLLBACK_LIMIT)
  })

  it('places a marker sitting exactly on the far edge of the window', () => {
    // Length and starting point rather than the whole 256 KB string: a failure
    // here should name the boundary, not print a quarter of a megabyte.
    const frame = resumeSnapshot(atEdge, marker)
    expect(frame.length).toBe(atEdge.length - head.length)
    expect(frame.startsWith(marker)).toBe(true)
  })

  it('does not look one character further back than the window', () => {
    // Not "fails to find it" — refuses to look. A client this far behind is
    // saving the last eighth of a replay it is about to receive in full
    // anyway, and the search that would find it is the whole exposure.
    const frame = resumeSnapshot(beyondEdge, marker)
    expect(frame.length).toBe(beyondEdge.length)
    expect(frame.startsWith(head)).toBe(true)
  })

  it('reads each character of the region it searches exactly once', () => {
    // The other half: a window alone still costs `window x marker` comparisons
    // under a naive backwards scan (~2 s for these numbers). KMP never moves
    // backwards through the haystack, and `IndexedChars` is what lets that be
    // counted instead of timed.
    const text = 'A'.repeat(50_000)
    let reads = 0
    const counted = {
      length: text.length,
      charCodeAt: (index: number): number => {
        reads += 1
        return text.charCodeAt(index)
      }
    }
    const from = 10_000
    // A needle that matches everywhere but the last character — the shape that
    // makes a naive scan quadratic.
    expect(lastIndexOfFrom(counted, `${'A'.repeat(999)}B`, from)).toBe(-1)
    expect(reads).toBe(text.length - from)
  })

  it('answers the input that froze the main process for fifteen seconds', () => {
    // The measured case, kept as an executable record: 2,000,000 identical
    // characters and a marker that misses by its last one.
    const hostile = 'A'.repeat(SCROLLBACK_LIMIT)
    const nearMiss = `${'A'.repeat(MAX_RESUME_TAIL_CHARS - 1)}B`
    const placeable = 'A'.repeat(MAX_RESUME_TAIL_CHARS)

    // The file fakes timers for the coalescing tests, and a faked clock reports
    // that everything took zero — which would make the assertion below pass
    // whatever the search did. The global `afterEach` restores them.
    vi.useRealTimers()
    const started = performance.now()
    const missed = resumeSnapshot(hostile, nearMiss)
    // The same buffer with a marker it CAN place, so the line above is a
    // verdict about the marker and not about the buffer: this one resumes from
    // the most recent occurrence, which is the tail itself.
    const placed = resumeSnapshot(hostile, placeable)
    const elapsed = performance.now() - started

    expect(missed.length).toBe(hostile.length)
    expect(placed.length).toBe(MAX_RESUME_TAIL_CHARS)
    // The one thing here a clock has to say, and it is a cost CLASS rather than
    // a benchmark: both properties above are asserted deterministically, but
    // neither would notice `resumeSnapshot` keeping the window and going back
    // to a naive scan inside it. Measured on this project's own limits: ~10 ms
    // as it stands, ~2,000 ms for the window alone, ~15,000 ms for neither.
    // The threshold sits an order of magnitude clear of both sides.
    expect(elapsed).toBeLessThan(200)
  })
})

describe('lastIndexOfFrom agrees with the search it replaces', () => {
  it('matches String.lastIndexOf across randomised inputs', () => {
    // A hand-rolled string search is a correctness risk in the main process,
    // and the reference implementation is right there: for every input where
    // both are allowed to look at the whole haystack, they must agree. The
    // alphabet is deliberately tiny, so partial matches, overlaps and repeats
    // are the common case rather than the exotic one.
    let checked = 0
    let matched = 0
    for (let seed = 1; seed <= 400; seed += 1) {
      // A cheap deterministic PRNG — a fixed sequence, so a failure reproduces.
      let state = seed * 2654435761
      const next = (bound: number): number => {
        state = (state * 1103515245 + 12345) & 0x7fffffff
        return state % bound
      }
      const draw = (length: number): string =>
        Array.from({ length }, () => 'ab\n'[next(3)]).join('')
      const haystack = draw(next(60) + 1)
      const needle = draw(next(5) + 1)
      const expected = haystack.lastIndexOf(needle)
      expect(lastIndexOfFrom(haystack, needle, 0)).toBe(expected)
      checked += 1
      if (expected >= 0) matched += 1
    }
    // Self-check: a generator that never produced a match would have proven
    // only that both agree on -1.
    expect(checked).toBe(400)
    expect(matched).toBeGreaterThan(100)
  })

  it('never reports a match that begins before `from`', () => {
    expect(lastIndexOfFrom('abcabc', 'abc', 0)).toBe(3)
    expect(lastIndexOfFrom('abcabc', 'abc', 3)).toBe(3)
    expect(lastIndexOfFrom('abcabc', 'abc', 4)).toBe(-1)
    // A match straddling the boundary does not count: the region is the region.
    expect(lastIndexOfFrom('xxabcxx', 'abc', 3)).toBe(-1)
  })

  it('refuses an empty needle and a needle longer than what is left', () => {
    expect(lastIndexOfFrom('abc', '', 0)).toBe(-1)
    expect(lastIndexOfFrom('abc', 'abcd', 0)).toBe(-1)
    expect(lastIndexOfFrom('abc', 'bc', 2)).toBe(-1)
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
