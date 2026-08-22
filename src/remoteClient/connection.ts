/**
 * When the remote client reconnects, and when it stops trusting a socket that
 * still claims to be open — as plain functions, so the policy is testable in
 * plain Node while `useRemote` keeps only the wiring.
 *
 * A phone does not lose a WebSocket loudly. It sleeps, the Tailscale route
 * dies under it, and the socket sits in `OPEN` forever with nothing ever
 * arriving; the browser fires no event because, as far as TCP is concerned,
 * nothing happened. So silence has to be turned into a decision. The probe is
 * a plain `refresh` frame: it is already part of `clientMessageSchema`, the
 * server answers it synchronously with a `workspaces` push, and it needs no
 * new protocol verb — an unknown `type` would simply be dropped by the
 * gateway's zod validator, which is exactly why no heartbeat frame was added.
 */
import { MAX_RESUME_TAIL_CHARS } from '@shared/remote/protocol'

/** First backoff step; the socket usually comes back on this one. */
export const RECONNECT_BASE_MS = 500
/** Backoff ceiling. A wake-up bypasses it — see `decideWake`. */
export const RECONNECT_MAX_MS = 10_000
/**
 * Silence after which an open socket has to prove itself.
 *
 * The probe fires on SILENCE, not on activity: a busy session pushes on its
 * own and never reaches this timer, so the only pushes this rule adds are the
 * ones that arrive when nothing has happened.
 *
 * ## What the proof costs, stated rather than waved away
 *
 * The server answers `refresh` with a full `workspaces` frame — every
 * workspace, every agent row, every task row — whether or not anything
 * changed. `isSamePayload` makes that free for React; it does NOT make it free
 * for the radio. A run with a handful of agents and a task board serializes to
 * a few KB, so a foreground tab left open on an idle run pays roughly
 * `payload x 2/min` — order 100-400 KB per hour of staring at it. A
 * backgrounded tab pays nothing (`decideLiveness` refuses to probe one), and
 * an active run pays nothing extra because its own pushes reset the timer.
 *
 * That cost buys the only evidence a browser can get: JS cannot send a
 * WebSocket ping, and an invented `ping` verb would be dropped by the
 * gateway's zod validator, which is why the probe reuses `refresh`. The
 * cheaper design — have the server answer `refresh` with `workspaces` only
 * when the payload changed — cannot be used HERE, because a probe that gets no
 * answer is by construction a dead route: silence is the failure signal, so
 * the answer has to arrive even when it says nothing. Buying it back would
 * take a second server->client verb, which this protocol does not have.
 *
 * Raising the window would only lengthen how long a dead route looks alive.
 */
export const LIVENESS_SILENCE_MS = 30_000
/** How long that proof may take before the socket counts as dead. */
export const LIVENESS_PROBE_TIMEOUT_MS = 10_000
/** How often the liveness rule is evaluated. */
export const LIVENESS_TICK_MS = 5_000

/**
 * Capped exponential backoff. `attempt` counts the reconnects already tried,
 * so attempt 0 is the first retry.
 */
export function reconnectDelayMs(attempt: number): number {
  const step = Math.max(0, Math.trunc(attempt))
  // `2 ** step` overflows to Infinity for absurd inputs; `min` still caps it.
  return Math.min(RECONNECT_BASE_MS * 2 ** step, RECONNECT_MAX_MS)
}

/** The pairing token travels in the URL fragment, never in the query. */
export function tokenFromHash(hash: string): string | undefined {
  const params = new URLSearchParams(hash.replace(/^#/, ''))
  const token = params.get('token')
  return token ? token : undefined
}

export interface LivenessState {
  now: number
  /** When the last frame of any kind arrived from the server. */
  lastInboundAt: number
  /** When the outstanding probe was sent, or null when none is in flight. */
  probeSentAt: number | null
  /**
   * A backgrounded tab has its timers throttled to minutes, so its silence
   * says nothing about the route. Probing it would only churn the socket on
   * every wake — the wake handler covers that case instead.
   */
  visible: boolean
  open: boolean
}

export type LivenessAction = 'wait' | 'probe' | 'reconnect'

export function decideLiveness(state: LivenessState): LivenessAction {
  if (!state.open || !state.visible) return 'wait'
  if (state.probeSentAt !== null) {
    return state.now - state.probeSentAt >= LIVENESS_PROBE_TIMEOUT_MS ? 'reconnect' : 'wait'
  }
  return state.now - state.lastInboundAt >= LIVENESS_SILENCE_MS ? 'probe' : 'wait'
}

/**
 * What a wake-up (tab shown, network back, bfcache restore) should do, given
 * the socket's `readyState` — or null when there is no socket at all.
 *
 * The point of this is latency: after a sleep the backoff timer may be halfway
 * through a ten-second wait for a connection that would now succeed instantly.
 */
export type WakeAction = 'wait' | 'probe' | 'reconnect'

/** `WebSocket.CONNECTING` / `OPEN`, spelled out so this module needs no DOM. */
const CONNECTING = 0
const OPEN = 1

export function decideWake(readyState: number | null): WakeAction {
  if (readyState === OPEN) return 'probe'
  // A handshake already in flight will resolve or close on its own; racing a
  // second socket against it is how double-connects start.
  if (readyState === CONNECTING) return 'wait'
  return 'reconnect'
}

/**
 * Whether an inbound push carries state the client already has.
 *
 * The liveness probe is a `refresh`, and the server answers it with a full
 * `workspaces` push whether or not anything changed. Handing that array
 * straight to `setState` would hand React a new identity every 30 idle
 * seconds and re-run every `useMemo` keyed on it — the ordering, the question
 * inbox, the task board — to produce byte-identical output. Comparing first
 * costs one serialization of a list of workspace summaries; the payloads
 * being compared both came off the same wire and the same serializer, so key
 * order is stable and a string compare is a faithful deep compare here.
 */
export function isSamePayload(previous: unknown, next: unknown): boolean {
  return JSON.stringify(previous) === JSON.stringify(next)
}

/**
 * How long a command may stay unsettled before the client gives up on it.
 *
 * Covers both ways a command can go quiet: parked in the queue below waiting
 * for a socket, and already on the wire but never answered (the server drops
 * any frame its schema rejects, and a dropped `command` frame produces no
 * `command_result`). Either way the promise MUST settle — an Answer button
 * stuck on "sending ..." leaves the agent blocked with no way back but a
 * reload, which throws away every draft on the page.
 *
 * Sized to outlast an ordinary reconnect, and `connection.test.ts` pins it
 * against the pieces rather than against itself: the liveness rule needs
 * `LIVENESS_SILENCE_MS + LIVENESS_PROBE_TIMEOUT_MS` (40 s) to convict a route
 * that died without closing, and the reconnect it then triggers costs at most
 * one `RECONNECT_MAX_MS` step. A deadline shorter than that would reject
 * commands the very next `hello` was about to deliver — which is the failure
 * the queue exists to prevent, arriving by a different door. Anything still
 * unsettled after this has not lost a race, it has lost the route.
 */
export const COMMAND_TIMEOUT_MS = 45_000

/**
 * How many commands may wait for a socket at once. A phone in a tunnel taps
 * on; without a bound the queue is an unbounded replay of everything the user
 * did while disconnected. The oldest taps are the ones the user has given up
 * on, so they are the ones dropped.
 */
export const COMMAND_QUEUE_LIMIT = 8

/**
 * Mirror of the `args` value cap in `clientMessageSchema` (`protocol.ts`).
 * The server drops a frame that fails `safeParse` without answering it, so a
 * paste past this cap is a command that can never be answered; the client has
 * to refuse it itself rather than park a promise nothing will settle.
 * `connection.test.ts` pins this number against the schema it mirrors.
 */
export const MAX_COMMAND_ARG_CHARS = 20_000

/** Whether a command's structured args can survive the server's validator. */
export function commandArgsWithinLimits(args: Record<string, string> | undefined): boolean {
  if (!args) return true
  return Object.values(args).every((value) => value.length <= MAX_COMMAND_ARG_CHARS)
}

/**
 * Should this command go straight out, or wait for a socket?
 *
 * Queueing rather than rejecting is a deliberate choice about what a phone
 * actually is: `phase === 'connecting'` is not an exceptional state there, it
 * is most of a walk out of Wi-Fi range, and the tap made one second before the
 * socket comes back is the common case, not the edge one. Rejecting it makes
 * the user retype an answer they already wrote. The queue is only honest
 * because it is bounded ({@link commandsToEvict}) and every entry carries a
 * deadline ({@link expiredCommandIds}) — a queue without those is the same
 * hang with more steps.
 */
export function decideCommandDispatch(state: { open: boolean }): 'send' | 'queue' {
  return state.open ? 'send' : 'queue'
}

/** Which queued commands the bound forces out, oldest first. */
export function commandsToEvict(queuedIds: readonly string[]): string[] {
  const excess = queuedIds.length - COMMAND_QUEUE_LIMIT
  return excess > 0 ? queuedIds.slice(0, excess) : []
}

/** Which parked commands have outlived {@link COMMAND_TIMEOUT_MS}. */
export function expiredCommandIds(
  parked: Iterable<readonly [string, { expiresAt: number }]>,
  now: number
): string[] {
  const expired: string[] = []
  for (const [id, entry] of parked) {
    if (now >= entry.expiresAt) expired.push(id)
  }
  return expired
}

/**
 * Whether an attach should offer the tail it holds as a resume marker.
 *
 * The marker buys a trimmed replay (see `MAX_RESUME_TAIL_CHARS`) and costs its
 * own size in upload, every reconnect, on the leg of a cellular link that is
 * usually the slower one. A tail that has not filled yet is proof that this
 * client has seen less output than the marker would cost to send — so the
 * replay it could save is smaller than the marker itself, and the trade is a
 * loss. Above the cap it is not close: 16 KB up against a scrollback that runs
 * to 2,000,000 characters.
 *
 * The gate is on the CLIENT's tail rather than on anything the host reports,
 * because the host cannot answer it: the bridge is built fresh per socket and
 * remembers nothing about who was watching before.
 */
export function offersResumeMarker(tail: string | undefined): boolean {
  return tail !== undefined && tail.length >= MAX_RESUME_TAIL_CHARS
}

/**
 * The three-way race a close event has to survive, as facts rather than as a
 * chain of `if`s buried in a socket callback.
 *
 * `isCurrent` is the whole game: `connect()` drops the previous socket by
 * clearing `socketRef` BEFORE closing it, so the orphan's `onclose` arrives
 * after a replacement is already in place. That late event must not schedule a
 * reconnect (the replacement is already connecting) and must not fail parked
 * commands (by then they belong to the replacement).
 */
export interface SocketCloseContext {
  /** Is the socket that closed still the one `socketRef` points at? */
  isCurrent: boolean
  /** Is the hook still mounted? */
  alive: boolean
  /** Is there still a session to reconnect with? */
  hasSession: boolean
}

/** May this close schedule the next reconnect? */
export function shouldScheduleReconnect(context: SocketCloseContext): boolean {
  return context.isCurrent && context.alive && context.hasSession
}

/**
 * May this close reject the commands parked on it? Only the current socket's,
 * for the reason above — an orphan's commands were already settled by the
 * `connect()` call that orphaned it.
 */
export function shouldFailParkedCommands(context: Pick<SocketCloseContext, 'isCurrent'>): boolean {
  return context.isCurrent
}

/**
 * What a pairing exchange (`POST /api/auth`) actually turned out to be.
 *
 * The distinction the rest of this section rests on: a desktop that ANSWERED
 * and said no is a fact about the token, while a request that never reached a
 * desktop is a fact about the route — and a phone that opens its home-screen
 * bookmark before the tailnet is up produces the second one every time. The
 * client used to have only one shape for both, so a lift ride looked exactly
 * like a revoked device.
 */
export type PairingOutcome =
  | { kind: 'paired'; session: string }
  | { kind: 'rejected' }
  | { kind: 'unreachable' }

/** The half of {@link PairingOutcome} that needs a recovery decision. */
export type PairingFailure = 'rejected' | 'unreachable'

/**
 * Which of the three ways into pairing this attempt came from. The same
 * failure means different things down each one, which is the entire reason
 * this is a table rather than an `if`.
 */
export type PairingSource =
  /** A freshly scanned QR / pairing link, token still in the URL fragment. */
  | 'link'
  /** The pairing token kept in `localStorage` for a home-screen bookmark. */
  | 'stored'
  /** A `session_revoked` that was not a decision about this device. */
  | 'repair'

export type PairingRecovery =
  /** The route is the problem: keep every credential and try again later. */
  | 'retry'
  /** The link is spent — say so, and offer to pair again. */
  | 'showPairingFailed'
  /** The stored token is spent: forget it and go back to the QR screen. */
  | 'forgetPairing'
  /** The desktop no longer knows this device at all. */
  | 'revoke'

/**
 * What to do about a pairing attempt that did not yield a session.
 *
 * Only a desktop that answered may cost the user their stored credentials.
 * Every `'unreachable'` row is a retry precisely because the alternatives all
 * end at a QR code the user cannot scan from a lift — the phone is not
 * unpaired, it is out of range, and the fix is to wait rather than to walk
 * back to the desktop.
 */
export function decidePairingRecovery(
  failure: PairingFailure,
  source: PairingSource
): PairingRecovery {
  if (failure === 'unreachable') return 'retry'
  switch (source) {
    case 'link':
      return 'showPairingFailed'
    case 'stored':
      return 'forgetPairing'
    case 'repair':
      return 'revoke'
  }
}

/**
 * Read a non-`ok` HTTP status as one or the other kind of failure.
 *
 * Not every answer is an answer to the question that was asked. `429` is the
 * server's own rate limiter (`auth.pair` throttles per address BEFORE it
 * compares the token, so a 429 says nothing about whether the token is good),
 * and a `5xx` is a desktop that is up but broken or a proxy in the way. Both
 * are "ask again", and treating them as "the desktop said no" would delete a
 * perfectly good pairing token because the user reloaded three times in a row.
 *
 * `4xx` other than those is the desktop declining this token: `401` from the
 * auth store, `400` from a malformed body, `403` from the host-rebinding
 * guard.
 */
export function pairingFailureFromStatus(status: number): PairingFailure {
  if (status === 408 || status === 429 || status >= 500) return 'unreachable'
  return 'rejected'
}
