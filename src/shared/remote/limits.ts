/**
 * Wire limits both processes agree on, kept apart from the schemas that use
 * them.
 *
 * This module exists for one reason: the browser client needs these numbers
 * and needs nothing else from `protocol.ts`. A value import there pulls zod
 * into the phone's entry chunk — 13 kB gzipped, on a page loaded over a
 * tailnet, to read one integer — and the client validates nothing with it.
 * Types from `protocol.ts` are free because they erase; constants are not.
 */

/**
 * How much of an agent's output a client may offer back as a resume marker on
 * `attach`.
 *
 * Reconnecting is the normal state of a phone, not an error: a liveness
 * verdict, a `visibilitychange`, a bfcache `pageshow` and an `online` event
 * all produce one, and every one of them re-attaches every terminal the UI is
 * watching. Replaying the full scrollback each time costs up to
 * `SCROLLBACK_LIMIT` (2,000,000 characters, more once JSON escapes the ANSI)
 * per agent per reconnect — on cellular, the single largest cost in the whole
 * remote design, and one the client's own reconnect policy causes.
 *
 * A marker turns that into a fixed 16 KB up and 16 KB + the delta back. It is
 * a HINT, never a promise: the bridge searches for it in the scrollback it
 * actually holds and falls back to a full replay whenever it is not there — a
 * head-trimmed buffer, a restarted agent, a client that sent nothing. What the
 * client discards on a successful resume is exactly what it already had, so
 * nothing that reaches a terminal is lost either way.
 *
 * Sized at twice the client's own alignment window (`OVERLAP_TAIL_CHARS`,
 * 8192) so the marker is always a superset of the tail the client aligns on —
 * `connection.test.ts` pins that relationship.
 *
 * The cap is also the schema's, but it is NOT what bounds the work the frame
 * asks of the main process: this length multiplied by a 2,000,000-character
 * scrollback is a product, and under a naive backwards scan that product was
 * fifteen seconds of synchronous freeze from a single `attach`. The bound that
 * matters lives with the search — `MAX_RESUME_DELTA_CHARS` and
 * `lastIndexOfFrom` in `terminalBridge.ts`, both pinned by its tests.
 */
export const MAX_RESUME_TAIL_CHARS = 16_384
