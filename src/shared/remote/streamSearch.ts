/**
 * Finding one side of the terminal stream inside the other.
 *
 * Both ends of the remote protocol align on the same trick: a client that has
 * been away holds the tail of what it already saw, and the newest snapshot of
 * the same PTY contains that tail somewhere inside it. Locating it turns "send
 * and rebuild everything" into "send and append the delta". The host does it in
 * `terminalBridge.resumeSnapshot` to decide how much of the scrollback to put
 * on the wire; the phone does it in `terminalAttach.planAttach` to decide
 * whether the terminal on screen can be continued or has to be reset.
 *
 * Two callers, one search, and it lives here because the client bundle must not
 * import from `src/main/` — `vite.remoteClient.config.ts` gives it `@shared`
 * and nothing else.
 *
 * What each caller does with the answer is NOT shared, and deliberately so:
 * the host searches a window (a match 1.9 MB back saves bandwidth it was never
 * billed for) while the client searches the whole snapshot (a miss there costs
 * `reset()` — the reader's place, the alternate screen and the local buffer —
 * so it is worth looking everywhere). Each caller owns that policy; this module
 * owns only the cost of looking.
 */

/**
 * Everything {@link lastIndexOfFrom} may do to the text it searches: ask how
 * long it is and read one character at a time. A `string` satisfies it, and so
 * does a counting stand-in — which is how both callers' tests pin the search's
 * cost exactly, by the number of characters it reads, instead of with a
 * stopwatch.
 */
export interface IndexedChars {
  readonly length: number
  charCodeAt(index: number): number
}

/**
 * The index of the LAST occurrence of `needle` at or after `from`, or -1.
 *
 * Knuth-Morris-Pratt, not `String.prototype.lastIndexOf`, and not for elegance:
 * V8's is a naive scan that re-compares from scratch after every mismatch, so
 * a haystack of one repeated character and a marker that nearly matches costs
 * `haystack x needle` character comparisons. Measured on this project's own
 * limits, that is seconds of a synchronous freeze at either end — **15 seconds**
 * in the Electron main process for a 2,000,000-character scrollback and a
 * 16,384-character marker that misses by its last character, and **8 seconds**
 * in the phone's renderer for the same scrollback against the client's own
 * 8,192-character tail. Neither input needs a hostile client: a progress bar or
 * a padded separator makes the homogeneous run, and a restarted agent or a
 * head-trimmed buffer makes the miss.
 *
 * KMP never re-reads a haystack character: it reads each one exactly once and
 * carries the partial match forward, so the cost is `region + needle` rather
 * than their product, whatever the input looks like. It reports the last match
 * because a client's position is the most RECENT occurrence of its tail;
 * resuming from an earlier one would replay output it has already seen.
 */
export function lastIndexOfFrom(haystack: IndexedChars, needle: string, from: number): number {
  const m = needle.length
  const start = Math.max(0, from)
  if (m === 0 || haystack.length - start < m) return -1
  // The prefix function: failure[i] is the length of the longest proper prefix
  // of needle[0..i] that is also a suffix of it — how far back to fall on a
  // mismatch without ever moving backwards through the haystack.
  const failure = new Int32Array(m)
  for (let i = 1, k = 0; i < m; i += 1) {
    while (k > 0 && needle.charCodeAt(i) !== needle.charCodeAt(k)) k = failure[k - 1]
    if (needle.charCodeAt(i) === needle.charCodeAt(k)) k += 1
    failure[i] = k
  }
  let last = -1
  for (let i = start, k = 0; i < haystack.length; i += 1) {
    const code = haystack.charCodeAt(i)
    while (k > 0 && code !== needle.charCodeAt(k)) k = failure[k - 1]
    if (code === needle.charCodeAt(k)) k += 1
    if (k === m) {
      last = i - m + 1
      // Keep going: a later occurrence is a better resume point than this one.
      k = failure[k - 1]
    }
  }
  return last
}
