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

/** First backoff step; the socket usually comes back on this one. */
export const RECONNECT_BASE_MS = 500
/** Backoff ceiling. A wake-up bypasses it — see `decideWake`. */
export const RECONNECT_MAX_MS = 10_000
/**
 * Silence after which an open socket has to prove itself.
 *
 * Deliberately unchanged now that the overview renders a question inbox and a
 * task board off the same `workspaces` payload, which makes the probe's answer
 * more expensive to diff. The probe fires on SILENCE, not on activity: a busy
 * session pushes on its own and never reaches this timer, so the only pushes
 * this rule adds are the ones that arrive when nothing has happened — exactly
 * when the diff is cheapest. `isSamePayload` below makes that case free.
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
