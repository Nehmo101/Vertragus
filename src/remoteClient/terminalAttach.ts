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
 * The search is `lastIndexOf`, not `indexOf`: our position in the stream is
 * the most recent occurrence of our tail, and taking an earlier one would
 * re-write output the reader has already seen.
 */
export function planAttach(input: AttachInput): AttachPlan {
  if (input.written === '') return { kind: 'append', data: input.snapshot }
  const end = input.snapshot.lastIndexOf(input.written)
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
