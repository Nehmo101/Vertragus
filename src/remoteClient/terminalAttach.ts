/**
 * What a re-attach is allowed to do to the terminal already on screen.
 *
 * The gateway builds a fresh bridge per socket, and this client reconnects
 * routinely by design — a liveness verdict, `visibilitychange`, a bfcache
 * `pageshow`, `online`. Every one of those produces a fresh `snapshot` frame
 * for each watched agent. Replaying that snapshot over a reset terminal, which
 * is the obvious thing to do, is wrong twice over:
 *
 *  - it throws the reader to the bottom, which is the "it keeps jumping away
 *    from what I was reading" complaint arriving through a second door — a
 *    phone that locks in a pocket 400 lines up comes back at the newest line;
 *  - it can destroy more history than it restores. `ScrollbackBuffer` keeps
 *    2,000,000 *characters* and trims from the head, while xterm holds 5000
 *    rendered lines; `reset()` also clears the DEC modes, so a replay whose
 *    alt-screen entry was trimmed away renders as scrolling garbage.
 *
 * So a re-attach is treated as what it actually is: the same byte stream,
 * seen again from further back. The client remembers the tail of everything it
 * has written and looks for that tail inside the new snapshot. Finding it
 * means the two streams are the same stream, and the only thing worth writing
 * is what comes after the match — the local buffer, the alt screen and the
 * reader's position all survive untouched. Not finding it means the streams
 * genuinely diverged (more than a full scrollback arrived while the phone was
 * away, or the agent restarted), and only then is a reset earned.
 *
 * A pure module rather than a branch in the component: this is the decision
 * the second complaint is about, and `.tsx` cannot be tested in this project.
 */
import { lastIndexOfFrom } from '@shared/remote/streamSearch'

/**
 * How much of the written stream is kept for matching. Long enough that a
 * chance repeat is not a real risk — a terminal would have to emit the same
 * 8 KB twice — and short enough to hold and to scan for on a phone.
 */
export const OVERLAP_TAIL_CHARS = 8192

/**
 * `append` continues the terminal that is already on screen; `replay` is the
 * admission that it can no longer be continued and has to be rebuilt.
 */
export type AttachPlan = { kind: 'append'; data: string } | { kind: 'replay'; data: string }

/** Where the viewport belongs once the plan has been applied. */
export type AttachScroll = 'bottom' | 'hold'

export interface AttachInput {
  /** The snapshot frame just received. */
  snapshot: string
  /** Tail of everything already written into this terminal — `''` when new. */
  written: string
}

/**
 * Decide what to write for an incoming snapshot.
 *
 * An empty `written` is the first attach: the terminal is blank, so appending
 * the whole snapshot and replaying it are the same act, and the cheaper one is
 * chosen so no reset ever happens on the happy path.
 *
 * The search is for the LAST occurrence, not the first: our position in the
 * stream is the most recent occurrence of our tail, and taking an earlier one
 * would re-write output the reader has already seen.
 *
 * It searches the whole snapshot, and it is {@link lastIndexOfFrom} rather than
 * `String.prototype.lastIndexOf`, for two halves of one reason.
 *
 * V8's `lastIndexOf` is a naive backwards scan, so a homogeneous run (a
 * progress bar, a padded separator) and a tail that nearly matches cost
 * `snapshot x tail` comparisons. Measured on this project's own limits — a
 * 2,000,000-character snapshot against the 8,192-character tail, on a
 * developer machine, so a phone is slower still — that was **8,000 ms** for a
 * miss and **1,130 ms** for a match 300 KB back, synchronous, in the renderer
 * of a phone that has just woken up. `lastIndexOfFrom` reads each character
 * exactly once, which brings both of those to **~45 ms**.
 *
 * That linear cost is what makes searching the WHOLE snapshot affordable, and
 * the host's opposite choice is not a contradiction. `terminalBridge` gives its
 * own search a 256 KB window because a marker it fails to place costs only
 * bandwidth it was never billed for. A tail this side fails to place costs
 * `reset()`: the local buffer, the alternate screen and the reader's position,
 * which is precisely the complaint this module exists to answer. The two misses
 * are also correlated — the host sends the full 2 MB exactly when it could not
 * place the client's marker — and the commonest reason it could not is that the
 * client is further back than its window, i.e. a client whose tail IS in that
 * snapshot, just not in the last 256 KB of it. A window here would turn every
 * one of those recoveries into a jump to the bottom.
 */
export function planAttach(input: AttachInput): AttachPlan {
  if (input.written === '') return { kind: 'append', data: input.snapshot }
  const end = lastIndexOfFrom(input.snapshot, input.written, 0)
  if (end < 0) return { kind: 'replay', data: input.snapshot }
  return { kind: 'append', data: input.snapshot.slice(end + input.written.length) }
}

/**
 * Where to leave the viewport. A replay has no position to preserve — the
 * buffer it referred to is gone — so it lands at the newest line. An append
 * keeps the reader exactly where they were unless they were already following,
 * which is the whole point of the module.
 */
export function attachScroll(plan: AttachPlan, following: boolean): AttachScroll {
  if (plan.kind === 'replay') return 'bottom'
  return following ? 'bottom' : 'hold'
}

/**
 * Remember the tail of the stream written so far. Called for the snapshot and
 * for every `data` frame, so the next re-attach has something to align on.
 */
export function trackWritten(written: string, data: string, limit = OVERLAP_TAIL_CHARS): string {
  if (limit <= 0) return ''
  if (data === '') return written.length > limit ? written.slice(-limit) : written
  const joined = written + data
  return joined.length > limit ? joined.slice(-limit) : joined
}
