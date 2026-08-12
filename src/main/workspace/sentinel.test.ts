import { describe, expect, it } from 'vitest'
import { buildReminderSuffix, buildTaskContract } from '@shared/prompts/contract'
import {
  rejoinSentinelPayload,
  SENTINEL_BUFFER_MAX,
  SENTINEL_DEDUP_MAX,
  SENTINEL_NOTE_MAX,
  SENTINEL_SUMMARY_MAX,
  SentinelParser
} from './sentinel'

const ESC = String.fromCharCode(27)

function doneLine(summary: string, status?: string): string {
  const body =
    status === undefined
      ? JSON.stringify({ summary })
      : JSON.stringify({ summary, status })
  return `@@VERTRAGUS:DONE@@${body}@@END@@`
}

function progressLine(note: string): string {
  return `@@VERTRAGUS:PROGRESS@@${JSON.stringify({ note })}@@END@@`
}

function askLine(question: string): string {
  return `@@VERTRAGUS:ASK@@${JSON.stringify({ question })}@@END@@`
}

/** Feed `text` as randomly-sized chunks; concatenate all reports. */
function feedSplit(parser: SentinelParser, text: string, sizes: number[]): ReturnType<SentinelParser['feed']> {
  const reports: ReturnType<SentinelParser['feed']> = []
  let offset = 0
  let sizeIndex = 0
  while (offset < text.length) {
    const size = sizes[sizeIndex % sizes.length]!
    sizeIndex += 1
    const next = text.slice(offset, offset + size)
    offset += next.length
    reports.push(...parser.feed(next))
  }
  return reports
}

describe('rejoinSentinelPayload', () => {
  it('strips wrap newlines and continuation borders', () => {
    expect(rejoinSentinelPayload('{"summary":"hi"}\n')).toBe('{"summary":"hi"}')
    expect(rejoinSentinelPayload('{"sum\n  mary":"x"}')).toBe('{"summary":"x"}')
    expect(rejoinSentinelPayload('{"a":1}\r\n│{"b"')).toBe('{"a":1}{"b"')
    expect(rejoinSentinelPayload('line\n┃  more')).toBe('linemore')
  })
})

describe('SentinelParser', () => {
  it('parses DONE / PROGRESS / ASK with defaults', () => {
    const parser = new SentinelParser()
    expect(parser.feed(doneLine('shipped it'))).toEqual([
      { kind: 'done', summary: 'shipped it', status: 'success', raw: doneLine('shipped it') }
    ])
    expect(parser.feed(doneLine('nope', 'failed'))).toEqual([
      {
        kind: 'done',
        summary: 'nope',
        status: 'failed',
        raw: doneLine('nope', 'failed')
      }
    ])
    expect(parser.feed(progressLine('compiled'))).toEqual([
      { kind: 'progress', note: 'compiled', raw: progressLine('compiled') }
    ])
    expect(parser.feed(askLine('which file?'))).toEqual([
      { kind: 'ask', question: 'which file?', raw: askLine('which file?') }
    ])
  })

  it('is invariant under random byte splits', () => {
    const line = `${doneLine('split-ok')} noise ${progressLine('mid')}`
    for (const sizes of [[1], [2, 5, 3], [7, 1, 11, 4], [13]]) {
      const parser = new SentinelParser()
      const reports = feedSplit(parser, line, sizes)
      expect(reports.map((report) => report.kind)).toEqual(['done', 'progress'])
      expect(reports[0]).toMatchObject({ kind: 'done', summary: 'split-ok' })
      expect(reports[1]).toMatchObject({ kind: 'progress', note: 'mid' })
    }
  })

  it('is invariant under byte splits that cut ANSI escapes mid-sequence', () => {
    const painted =
      `${ESC}[32m@@VERTRAGUS:DONE@@${ESC}[0m` + `{"summary":"ansi-split"}${ESC}E@@END@@`
    for (const sizes of [[1], [2, 3], [5, 1, 7]]) {
      const parser = new SentinelParser()
      const reports = feedSplit(parser, painted, sizes)
      expect(reports).toEqual([
        expect.objectContaining({ kind: 'done', summary: 'ansi-split', status: 'success' })
      ])
    }
  })

  it('rejoins a payload wrapped across TUI lines with border glyphs', () => {
    const wrapped = [
      '@@VERTRAGUS:DONE@@{"summary":"wrap',
      '│  ped ok","status":"blocked"}@@END@@'
    ].join('\n')
    const parser = new SentinelParser()
    expect(parser.feed(wrapped)).toEqual([
      {
        kind: 'done',
        summary: 'wrapped ok',
        status: 'blocked',
        raw: expect.stringContaining('@@VERTRAGUS:DONE@@')
      }
    ])
  })

  it('normalises ANSI / cursor breaks before matching', () => {
    const painted =
      `${ESC}[32m@@VERTRAGUS:DONE@@${ESC}[0m` +
      `{"summary":"green"}${ESC}E@@END@@`
    const parser = new SentinelParser()
    expect(parser.feed(painted)).toEqual([
      expect.objectContaining({ kind: 'done', summary: 'green', status: 'success' })
    ])
  })

  it('reassembles an ESC split across two feed() calls', () => {
    const parser = new SentinelParser()
    const prefix = `@@VERTRAGUS:DONE@@{"summary":"gr${ESC}`
    const suffix = `[0meen"}@@END@@`
    expect(parser.feed(prefix)).toEqual([])
    expect(parser.feed(suffix)).toEqual([
      expect.objectContaining({ kind: 'done', summary: 'green', status: 'success' })
    ])
  })

  it('parses a DONE at the head of a chunk even when the rest exceeds the buffer', () => {
    const parser = new SentinelParser()
    const flood = 'x'.repeat(SENTINEL_BUFFER_MAX + 100)
    expect(parser.feed(doneLine('shipped') + flood)).toEqual([
      expect.objectContaining({ kind: 'done', summary: 'shipped', status: 'success' })
    ])
    expect(parser.bufferLength).toBeLessThanOrEqual(
      SENTINEL_BUFFER_MAX + '@@VERTRAGUS:PROGRESS@@'.length - 1
    )
  })

  it('keeps the rolling buffer bounded after marker-free flood', () => {
    const parser = new SentinelParser()
    parser.feed('y'.repeat(500_000))
    expect(parser.bufferLength).toBeLessThanOrEqual(
      SENTINEL_BUFFER_MAX + '@@VERTRAGUS:PROGRESS@@'.length - 1
    )
  })

  it('caps dedup memory at SENTINEL_DEDUP_MAX with FIFO eviction', () => {
    const parser = new SentinelParser()
    for (let i = 0; i < SENTINEL_DEDUP_MAX + 10; i++) {
      parser.feed(doneLine(`payload-${i}`))
    }
    expect(parser.dedupSize).toBe(SENTINEL_DEDUP_MAX)
    // Oldest evicted — the first payload can fire again.
    expect(parser.feed(doneLine('payload-0'))).toHaveLength(1)
  })

  it('dedups an identical redrawn frame', () => {
    const line = doneLine('once')
    const parser = new SentinelParser()
    expect(parser.feed(line)).toHaveLength(1)
    expect(parser.feed(line)).toEqual([])
    const fresh = new SentinelParser()
    expect(fresh.feed(line + line)).toHaveLength(1)
  })

  it('reset clears buffer and dedup so a dangling start cannot complete later', () => {
    const parser = new SentinelParser()
    expect(parser.feed('@@VERTRAGUS:DONE@@{"summary":"x"}')).toEqual([])
    expect(parser.bufferLength).toBeGreaterThan(0)
    parser.feed(doneLine('remembered'))
    expect(parser.dedupSize).toBe(1)
    parser.reset()
    expect(parser.bufferLength).toBe(0)
    expect(parser.dedupSize).toBe(0)
    // Dangling start was dropped — END alone must not finish it.
    expect(parser.feed('@@END@@')).toEqual([])
    expect(parser.feed(doneLine('remembered'))).toHaveLength(1)
  })

  it('fires the same DONE again after reset (follow-up task)', () => {
    const line = doneLine('again')
    const parser = new SentinelParser()
    expect(parser.feed(line)).toHaveLength(1)
    parser.reset()
    expect(parser.feed(line)).toEqual([
      { kind: 'done', summary: 'again', status: 'success', raw: line }
    ])
  })

  it('emits unparseable for bad JSON, bad status, and oversized fields', () => {
    const parser = new SentinelParser()
    expect(parser.feed('@@VERTRAGUS:DONE@@{not-json}@@END@@')).toEqual([
      expect.objectContaining({ kind: 'unparseable', reason: 'invalid_json' })
    ])
    expect(parser.feed('@@VERTRAGUS:DONE@@{"summary":"x","status":"nope"}@@END@@')).toEqual([
      expect.objectContaining({ kind: 'unparseable', reason: 'invalid_status' })
    ])
    const huge = 'x'.repeat(SENTINEL_SUMMARY_MAX + 1)
    expect(parser.feed(`@@VERTRAGUS:DONE@@${JSON.stringify({ summary: huge })}@@END@@`)).toEqual([
      expect.objectContaining({ kind: 'unparseable', reason: 'invalid_summary' })
    ])
    const longNote = 'n'.repeat(SENTINEL_NOTE_MAX + 1)
    expect(parser.feed(`@@VERTRAGUS:PROGRESS@@${JSON.stringify({ note: longNote })}@@END@@`)).toEqual([
      expect.objectContaining({ kind: 'unparseable', reason: 'invalid_note' })
    ])
  })

  it('holds an incomplete span until END arrives', () => {
    const parser = new SentinelParser()
    expect(parser.feed('@@VERTRAGUS:DONE@@{"summary":"soon"}')).toEqual([])
    expect(parser.feed('@@END@@')).toEqual([
      expect.objectContaining({ kind: 'done', summary: 'soon' })
    ])
  })

  it('yields zero reports when fed the sentinel contract, reminder and a plain answer', () => {
    const contract = buildTaskContract({ role: 'worker', reporting: 'sentinel' })
    const reminder = buildReminderSuffix('sentinel')
    const answer = 'Use src/main/foo.ts for the change.\n\n' + reminder
    const parser = new SentinelParser()
    expect(feedSplit(parser, contract + '\n' + reminder + '\n' + answer, [1, 3, 7, 11])).toEqual([])
    // Also as one chunk (what a paste-echo looks like).
    expect(new SentinelParser().feed(contract)).toEqual([])
    expect(new SentinelParser().feed(answer)).toEqual([])
  })
})
