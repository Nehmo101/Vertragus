/**
 * Assemble submitted text from `terminal:input` chunks. Seed writes and
 * `sendToAgent` go through `pty.write` directly and never reach this — they
 * are plumbing, not the user's assignment.
 *
 * First successful submit sticks as {@link OrchestratorGoalAssembler.goalText};
 * later submits update {@link OrchestratorGoalAssembler.latestText} only.
 */
const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)
const DEL = String.fromCharCode(127)
const BACKSPACE = String.fromCharCode(8)
const CANCEL = String.fromCharCode(3)
const LINE_KILL = String.fromCharCode(21)
const PASTE_START = `${ESC}[200~`
const PASTE_END = `${ESC}[201~`

/** CSI: `ESC [ params/intermediate final` — arrows, bracketed-paste wrappers. */
const CSI_COMPLETE = new RegExp(`^${ESC}\\[[0-9;?]*[ -/]*[@-~]`)
/** Held across chunks so a split `\x1b[200~` is not half-eaten as text. */
const CSI_INCOMPLETE = new RegExp(`^${ESC}\\[[0-9;?]*[ -/]*$`)

/** Safety bound for absurd pastes — the hover still shows this many characters. */
export const GOAL_TEXT_MAX = 8000

export interface OrchestratorGoalAssembler {
  /** Feed a raw input chunk. True when a submit landed (first or later). */
  push(chunk: string): boolean
  /** First successful submit, full text. Never replaced. */
  readonly goalText: string | undefined
  /** Most recent successful submit, full text. */
  readonly latestText: string | undefined
}

export function createOrchestratorGoalAssembler(): OrchestratorGoalAssembler {
  let buffer = ''
  let hold = ''
  let goal: string | undefined
  let latest: string | undefined
  let pasting = false

  const append = (ch: string): void => {
    if (buffer.length >= GOAL_TEXT_MAX) return
    const room = GOAL_TEXT_MAX - buffer.length
    buffer += ch.length <= room ? ch : ch.slice(0, room)
  }

  const commit = (): boolean => {
    const text = buffer.trim()
    buffer = ''
    if (!text) return false
    latest = text
    if (goal === undefined) goal = text
    return true
  }

  return {
    get goalText(): string | undefined {
      return goal
    },
    get latestText(): string | undefined {
      return latest
    },
    push(chunk: string): boolean {
      if (!chunk) return false
      const text = hold + chunk
      hold = ''
      let changed = false
      let i = 0
      while (i < text.length) {
        const ch = text.charAt(i)
        if (ch === ESC) {
          const consumed = consumeEscape(text.slice(i))
          if (consumed === null) {
            hold = text.slice(i)
            break
          }
          const seq = text.slice(i, i + consumed)
          if (seq === PASTE_START) pasting = true
          else if (seq === PASTE_END) pasting = false
          i += consumed
          continue
        }
        if (ch === '\r') {
          // Inside bracketed paste, CR is content. Submit only outside an
          // open paste. LF stays in the buffer so a multi-line paste is one
          // goal, not a one-liner.
          if (pasting) append(ch)
          else changed = commit() || changed
          i += 1
          continue
        }
        if (ch === BACKSPACE || ch === DEL) {
          buffer = dropLastCodePoint(buffer)
          i += 1
          continue
        }
        // Ctrl+C / Ctrl+U abort the in-progress note. Skipping them used to
        // glue aborted composer text onto the first successful submit.
        if (ch === CANCEL || ch === LINE_KILL) {
          buffer = ''
          i += 1
          continue
        }
        if (ch < ' ' && ch !== '\n') {
          i += 1
          continue
        }
        append(ch)
        i += 1
      }
      return changed
    }
  }
}

/**
 * Bytes to skip for a complete escape, or `null` when the sequence is still
 * arriving. Bracketed-paste wrappers (`ESC [ 200 ~` / `ESC [ 201 ~`) are CSI,
 * so a paste becomes its text, not the escape codes.
 */
function consumeEscape(from: string): number | null {
  if (from.length < 2) return null
  const second = from.charAt(1)
  if (second === '[') {
    const complete = CSI_COMPLETE.exec(from)
    if (complete) return complete[0].length
    if (CSI_INCOMPLETE.test(from)) return null
    return 1
  }
  if (second === ']') {
    const bel = from.indexOf(BEL)
    const st = from.indexOf(`${ESC}\\`)
    if (bel >= 0 && (st < 0 || bel < st)) return bel + 1
    if (st >= 0) return st + 2
    return null
  }
  // Two-character Fe escapes (ESC 7, ESC =). A held ESC must not swallow the
  // following CR/LF as its second byte — that would drop the submit.
  if (second >= '@' && second <= '_') return 2
  return 1
}

function dropLastCodePoint(value: string): string {
  if (!value) return value
  const chars = [...value]
  chars.pop()
  return chars.join('')
}
