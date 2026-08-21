/**
 * Assemble the user's assignment to the orchestrator from `terminal:input`
 * chunks. Seed writes and `sendToAgent` go through `pty.write` directly and
 * never reach this — they are plumbing, not the user's assignment.
 *
 * First successful submit sticks: later steering in the same CLI must not
 * replace the workspace goal.
 */
import { taskNote } from './types'

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

export interface OrchestratorGoalAssembler {
  /** Feed a raw input chunk. True only when {@link goalText} newly lands. */
  push(chunk: string): boolean
  readonly goalText: string | undefined
}

export function createOrchestratorGoalAssembler(): OrchestratorGoalAssembler {
  let buffer = ''
  let hold = ''
  let goal: string | undefined
  let pasting = false

  const commit = (): boolean => {
    const note = taskNote(buffer)
    buffer = ''
    if (!note || goal !== undefined) return false
    goal = note
    return true
  }

  return {
    get goalText(): string | undefined {
      return goal
    },
    push(chunk: string): boolean {
      if (goal !== undefined || !chunk) return false
      const text = hold + chunk
      hold = ''
      let changed = false
      let i = 0
      while (i < text.length) {
        if (goal !== undefined) break
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
        if (ch === '\r' || ch === '\n') {
          // Inside bracketed paste, CR/LF is content (taskNote takes the first
          // line on commit). Submit only on CR/LF outside an open paste.
          if (pasting) buffer += ch
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
        if (ch < ' ') {
          i += 1
          continue
        }
        buffer += ch
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
