/**
 * PTY sentinel protocol parser — Channel B for `mcp: none` providers.
 *
 * Agents print lines of the form:
 *   @@VERTRAGUS:DONE@@{"summary":"…","status":"success"}@@END@@
 *   @@VERTRAGUS:ASK@@{"question":"…"}@@END@@
 *   @@VERTRAGUS:PROGRESS@@{"note":"…"}@@END@@
 *
 * The host converts those into the same `agent_done` / `agent_progress` /
 * `agent_question` events MCP tools would push.
 *
 * Hard problems this module owns (design §2.2):
 * 1. Echo of the contract — contract teaches split halves; we require a full
 *    start…end pair. Host-authored echoes are gated outside this module.
 * 2. ANSI + TUI rewrapping — incremental normalize (escape carry across
 *    chunks) then strip wrap artefacts before JSON.parse.
 * 3. Redraw dedup — content-hash of kind+payload, FIFO cap
 *    {@link SENTINEL_DEDUP_MAX}; {@link reset} clears buffer + dedup.
 * 4. ASK answering — Workspace + PendingQuestions (deliver-then-answer).
 */
import { createHash } from 'node:crypto'
import { AGENT_DONE_STATUSES, type AgentDoneStatus } from '@shared/schema/events'
import { normalizeTerminalChunk, splitIncompleteAnsiTail } from './terminalText'

/** Mirrors `report_done` / `ask_orchestrator` / `report_progress` zod maxes. */
export const SENTINEL_SUMMARY_MAX = 4_000
export const SENTINEL_QUESTION_MAX = 4_000
export const SENTINEL_NOTE_MAX = 500

/** Rolling normalised tail kept per agent — enough for a wrapped report line. */
export const SENTINEL_BUFFER_MAX = 8_192

/** Content-hash memory size; same spirit as pendingQuestions ANSWERED_MEMORY. */
export const SENTINEL_DEDUP_MAX = 50

const END_TOKEN = '@@END@@'

const START_TOKENS = {
  done: '@@VERTRAGUS:DONE@@',
  ask: '@@VERTRAGUS:ASK@@',
  progress: '@@VERTRAGUS:PROGRESS@@'
} as const

/** Longest start token — retained past the trim point so a straddling marker survives. */
export const SENTINEL_MAX_START_TOKEN = Math.max(
  ...Object.values(START_TOKENS).map((token) => token.length)
)

export type SentinelStartKind = keyof typeof START_TOKENS

export type SentinelReport =
  | { kind: 'done'; summary: string; status: AgentDoneStatus; raw: string }
  | { kind: 'ask'; question: string; raw: string }
  | { kind: 'progress'; note: string; raw: string }
  | { kind: 'unparseable'; raw: string; reason: string }

interface MatchedSpan {
  kind: SentinelStartKind
  /** Full matched text including start and end tokens (pre-rejoin). */
  raw: string
  /** Payload between tokens after wrap-rejoin. */
  payload: string
  /** Index past the end token in the buffer. */
  endIndex: number
}

/**
 * Strip TUI wrap artefacts between start and end tokens.
 *
 * Rewrapping inserts `\n`/`\r` and often re-indents the continuation with
 * spaces or box-drawing borders (`│`, `┃`). Compact JSON has no real newlines,
 * so those are always noise.
 *
 * TRADE: leading whitespace on continuation lines is stripped wholesale, so a
 * wrap that falls on a space inside a summary deletes that space
 * (`"hello world"` → `"helloworld"`). The report still parses; the orchestrator
 * may see a glued word. Border glyphs are always noise; spaces are ambiguous.
 */
export function rejoinSentinelPayload(between: string): string {
  return between
    .split(/\r\n|\n|\r/)
    .map((line, index) => (index === 0 ? line : line.replace(/^[ \t|│┃]+/u, '')))
    .join('')
}

function contentHash(kind: string, payload: string): string {
  return createHash('sha256').update(kind).update('\0').update(payload).digest('hex')
}

const DONE_STATUSES = new Set<string>(AGENT_DONE_STATUSES)

/**
 * Incremental, pure parser. One instance per PTY-only subagent.
 */
export class SentinelParser {
  private buffer = ''
  /** Raw bytes held across feed() calls for a split ANSI escape. */
  private ansiHold = ''
  private readonly seenOrder: string[] = []
  private readonly seen = new Set<string>()

  /** Test/inspection: normalised buffer length after the last feed/trim. */
  get bufferLength(): number {
    return this.buffer.length
  }

  /** Test/inspection: how many distinct payloads are remembered. */
  get dedupSize(): number {
    return this.seen.size
  }

  /**
   * Feed a raw PTY chunk; returns newly recognised reports (may be empty).
   *
   * Match runs **before** the rolling trim so a complete report at the head of
   * a large chunk is never discarded. Incomplete ANSI escapes are held across
   * calls. An orphaned start token (no END yet) pairs with the next END — both
   * spans become one `unparseable`; bounded and self-healing.
   */
  feed(chunk: string): SentinelReport[] {
    const combined = this.ansiHold + chunk
    const { ready, hold } = splitIncompleteAnsiTail(combined)
    this.ansiHold = hold
    this.buffer += normalizeTerminalChunk(ready)

    const reports = this.drainMatches()
    this.trimBuffer()
    return reports
  }

  /**
   * Clear buffer, ANSI hold and dedup memory. Call when a new assignment is
   * delivered so a legitimate identical DONE for a follow-up task still fires.
   */
  reset(): void {
    this.buffer = ''
    this.ansiHold = ''
    this.seen.clear()
    this.seenOrder.length = 0
  }

  private drainMatches(): SentinelReport[] {
    const reports: SentinelReport[] = []
    for (;;) {
      const match = this.findNext()
      if (!match) break
      this.buffer = this.buffer.slice(match.endIndex)

      const hash = contentHash(match.kind, match.payload)
      if (!this.remember(hash)) continue

      reports.push(this.toReport(match))
    }
    return reports
  }

  /**
   * After parsing, keep a bounded tail. Retain
   * `SENTINEL_BUFFER_MAX + maxStartToken - 1` so a start token straddling the
   * cut is not sliced in half.
   */
  private trimBuffer(): void {
    const keep = SENTINEL_BUFFER_MAX + SENTINEL_MAX_START_TOKEN - 1
    if (this.buffer.length > keep) {
      this.buffer = this.buffer.slice(-keep)
    }
  }

  private remember(hash: string): boolean {
    if (this.seen.has(hash)) return false
    this.seen.add(hash)
    this.seenOrder.push(hash)
    while (this.seenOrder.length > SENTINEL_DEDUP_MAX) {
      const evicted = this.seenOrder.shift()
      if (evicted) this.seen.delete(evicted)
    }
    return true
  }

  private findNext(): MatchedSpan | null {
    let best: { kind: SentinelStartKind; start: number } | null = null
    for (const kind of Object.keys(START_TOKENS) as SentinelStartKind[]) {
      const token = START_TOKENS[kind]
      const index = this.buffer.indexOf(token)
      if (index < 0) continue
      if (!best || index < best.start) best = { kind, start: index }
    }
    if (!best) return null

    const startToken = START_TOKENS[best.kind]
    const payloadStart = best.start + startToken.length
    const endAt = this.buffer.indexOf(END_TOKEN, payloadStart)
    if (endAt < 0) return null

    const between = this.buffer.slice(payloadStart, endAt)
    const raw = this.buffer.slice(best.start, endAt + END_TOKEN.length)
    return {
      kind: best.kind,
      raw,
      payload: rejoinSentinelPayload(between),
      endIndex: endAt + END_TOKEN.length
    }
  }

  private toReport(match: MatchedSpan): SentinelReport {
    let parsed: unknown
    try {
      parsed = JSON.parse(match.payload) as unknown
    } catch {
      return { kind: 'unparseable', raw: match.raw, reason: 'invalid_json' }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { kind: 'unparseable', raw: match.raw, reason: 'invalid_json' }
    }
    const body = parsed as Record<string, unknown>

    if (match.kind === 'done') {
      const summary = typeof body.summary === 'string' ? body.summary : ''
      if (!summary || summary.length > SENTINEL_SUMMARY_MAX) {
        return { kind: 'unparseable', raw: match.raw, reason: 'invalid_summary' }
      }
      let status: AgentDoneStatus = 'success'
      if (body.status !== undefined) {
        if (typeof body.status !== 'string' || !DONE_STATUSES.has(body.status)) {
          return { kind: 'unparseable', raw: match.raw, reason: 'invalid_status' }
        }
        status = body.status as AgentDoneStatus
      }
      return { kind: 'done', summary, status, raw: match.raw }
    }

    if (match.kind === 'ask') {
      const question = typeof body.question === 'string' ? body.question : ''
      if (!question || question.length > SENTINEL_QUESTION_MAX) {
        return { kind: 'unparseable', raw: match.raw, reason: 'invalid_question' }
      }
      return { kind: 'ask', question, raw: match.raw }
    }

    const note = typeof body.note === 'string' ? body.note : ''
    if (!note || note.length > SENTINEL_NOTE_MAX) {
      return { kind: 'unparseable', raw: match.raw, reason: 'invalid_note' }
    }
    return { kind: 'progress', note, raw: match.raw }
  }
}
