/**
 * One remote client's view of the terminals it is watching.
 *
 * Mirrors the desktop terminal IPC (`ipc.ts`): a snapshot on attach, then a
 * coalesced live stream, so a phone attaching gets the full scrollback and
 * never a duplicated chunk. Each client owns its own bridge, and each attach
 * is an independent {@link TerminalDirectory} subscription — a reconnecting
 * phone re-attaches from scratch and the lossless scrollback makes that whole.
 *
 * "From scratch" is what it costs, and a phone reconnects by design rather than
 * by accident, so an attach may name the tail it already holds and be answered
 * with the stream from there — {@link resumeSnapshot}. The bridge is built
 * fresh per socket and remembers nothing between them, which is exactly why
 * that marker has to come from the client; and because it is only ever a hint
 * the bridge tries to place, a marker it cannot find costs one failed search
 * and the full replay that would have happened anyway.
 *
 * The coalescing (one frame) is the same reason it exists on the IPC side: a
 * chatty CLI emits dozens of tiny chunks a second, and each one crossing a
 * WebSocket as its own frame is pure overhead.
 */
import type { TerminalDirectory, TerminalSubscription } from '@main/ipc'
import type { ServerMessage } from '@shared/remote/protocol'
import { lastIndexOfFrom } from '@shared/remote/streamSearch'

export const REMOTE_COALESCE_MS = 16

/** Max bytes buffered per agent before a forced flush — backpressure guard. */
const MAX_PENDING_BYTES = 256 * 1024

interface Attachment {
  subscription: TerminalSubscription
  pending: string
  timer: ReturnType<typeof setTimeout> | undefined
}

export interface TerminalBridgeDeps {
  terminals: TerminalDirectory
  send: (message: ServerMessage) => void
  coalesceMs?: number
}

export interface TerminalBridge {
  /**
   * Start streaming an agent. `resume` is the tail of the stream the client
   * already holds — see {@link resumeSnapshot}; omit it and the whole
   * scrollback is replayed, which is what every attach did before it existed.
   */
  attach(agentId: string, resume?: string): void
  detach(agentId: string): void
  input(agentId: string, data: string): void
  resize(agentId: string, cols: number, rows: number): void
  /** Detach everything — the client disconnected or the server is shutting down. */
  dispose(): void
}

/**
 * How far back in the scrollback a resume marker is looked for.
 *
 * A marker is a claim about where the client stopped reading, so the only
 * place it can honestly land is near the END of the stream — the delta is
 * whatever the agent emitted while the phone was away. Searching further back
 * than that buys nothing: a match 1.9 MB from the end would "save" the last
 * 100 KB of a 2 MB replay, which is not the bill this feature was written for.
 *
 * So the search is given a region rather than the whole buffer, and the region
 * is what makes its cost a number instead of a product. 256 KB is an eighth of
 * `SCROLLBACK_LIMIT`: a marker found anywhere inside it still saves at least
 * seven eighths of a full replay, and a client further behind than that takes
 * the full replay it would have taken before this feature existed.
 *
 * The window is HALF the fix. The other half is {@link lastIndexOfFrom}: a
 * naive backwards scan (which is what `String.prototype.lastIndexOf` is in V8)
 * costs `region x marker` comparisons on homogeneous input, so even this
 * window would cost seconds. `terminalBridge.test.ts` pins both halves.
 */
export const MAX_RESUME_DELTA_CHARS = 262_144

/**
 * How much of the scrollback an attach has to replay, given what the client
 * says it already has.
 *
 * The client's marker is a contiguous run of this agent's own output ending at
 * whatever it last saw. Finding it in the scrollback identifies the same point
 * in the same stream, and everything before it is output the client is holding
 * already — it would be re-sent only to be thrown away on arrival, because a
 * re-attaching client aligns on its tail and appends what follows rather than
 * rebuilding from the replay.
 *
 * The returned string STARTS AT the match rather than after it. That is the
 * whole safety of the scheme: the frame still contains the client's own tail,
 * so a client aligning on it finds it exactly where it expects to and the
 * "snapshot is a prefix-compatible view of the same stream" contract survives
 * verbatim. The marker echo costs 16 KB against the up-to-2 MB it saves.
 *
 * Every way of not finding it — no marker, a marker longer than the whole
 * scrollback, a head-trim that ate it, a restarted agent whose output shares
 * nothing with it, a client more than {@link MAX_RESUME_DELTA_CHARS} behind —
 * returns the full snapshot, so the fallback is the old behaviour rather than a
 * degraded one. The search that decides this runs in the main process on a
 * frame the client chose the size and content of, which is why it is bounded
 * twice over: {@link MAX_RESUME_DELTA_CHARS} bounds how much of the snapshot it
 * may touch, and {@link lastIndexOfFrom} bounds what it may do to each
 * character it touches (read it once).
 *
 * One qualification the scheme has always carried, now written down: it is
 * lossless in practice, not in the strict sense. If the same 16 KB block recurs
 * AFTER the client's true position, the bridge resumes from the later
 * occurrence and the output in between is silently dropped. It takes a terminal
 * emitting the same 16 KB twice — `planAttach`'s 8 KB search on the client has
 * the identical shape and predates this — so the risk is theoretical, but it is
 * a risk, not an absence of one.
 */
export function resumeSnapshot(snapshot: string, resume: string | undefined): string {
  if (!resume || resume.length > snapshot.length) return snapshot
  const from = snapshot.length - (resume.length + MAX_RESUME_DELTA_CHARS)
  const at = lastIndexOfFrom(snapshot, resume, from)
  return at <= 0 ? snapshot : snapshot.slice(at)
}

export function createTerminalBridge(deps: TerminalBridgeDeps): TerminalBridge {
  const coalesceMs = deps.coalesceMs ?? REMOTE_COALESCE_MS
  const attachments = new Map<string, Attachment>()

  const flush = (agentId: string): void => {
    const attachment = attachments.get(agentId)
    if (!attachment) return
    if (attachment.timer) {
      clearTimeout(attachment.timer)
      attachment.timer = undefined
    }
    if (!attachment.pending) return
    const data = attachment.pending
    attachment.pending = ''
    deps.send({ type: 'data', agentId, data })
  }

  const schedule = (agentId: string): void => {
    const attachment = attachments.get(agentId)
    if (!attachment) return
    // Checked on EVERY append, not just the first of a cycle: a burst of small
    // chunks inside one coalesce window would otherwise grow `pending` without
    // bound because the timer is already set.
    if (attachment.pending.length >= MAX_PENDING_BYTES) {
      flush(agentId)
      return
    }
    if (attachment.timer) return
    attachment.timer = setTimeout(() => flush(agentId), coalesceMs)
    attachment.timer.unref?.()
  }

  return {
    attach(agentId: string, resume?: string): void {
      if (attachments.has(agentId)) return
      const subscription = deps.terminals.attach(agentId, {
        onData: (data) => {
          const attachment = attachments.get(agentId)
          if (!attachment || !data) return
          attachment.pending += data
          schedule(agentId)
        },
        onExit: (info) => {
          flush(agentId)
          deps.send({ type: 'exit', agentId, exitCode: info.exitCode ?? null })
          // Drop the attachment: the PTY is dead, and a later `input` frame
          // must be ignored (the `attachments.has` guard) rather than written
          // into a dead node-pty. Detach the subscription too so no listener
          // lingers on the dead pty.
          const attachment = attachments.get(agentId)
          if (attachment) {
            if (attachment.timer) clearTimeout(attachment.timer)
            attachment.subscription.detach()
            attachments.delete(agentId)
          }
        }
      })
      if (!subscription) {
        deps.send({ type: 'error', message: `unknown agent ${agentId}` })
        return
      }
      attachments.set(agentId, { subscription, pending: '', timer: undefined })
      // Snapshot first, then the stream — exactly the sync point the desktop
      // window uses, so the client can concatenate them without dedup. The
      // snapshot is trimmed to what this client is missing when it said what it
      // already has; the sync point is unchanged either way.
      deps.send({
        type: 'snapshot',
        agentId,
        snapshot: resumeSnapshot(subscription.snapshot, resume),
        cols: subscription.cols,
        rows: subscription.rows,
        name: subscription.meta.name,
        roleColor: subscription.meta.roleColor,
        exitCode: subscription.exit?.exitCode ?? null
      })
    },
    detach(agentId: string): void {
      const attachment = attachments.get(agentId)
      if (!attachment) return
      if (attachment.timer) clearTimeout(attachment.timer)
      attachment.subscription.detach()
      attachments.delete(agentId)
    },
    input(agentId: string, data: string): void {
      // Only agents this client is actually watching — an input to an
      // un-attached agent is a protocol violation, dropped silently.
      if (!attachments.has(agentId)) return
      deps.terminals.write(agentId, data)
    },
    resize(agentId: string, cols: number, rows: number): void {
      if (!attachments.has(agentId)) return
      deps.terminals.resize(agentId, cols, rows)
    },
    dispose(): void {
      for (const [agentId, attachment] of attachments) {
        if (attachment.timer) clearTimeout(attachment.timer)
        attachment.subscription.detach()
        attachments.delete(agentId)
      }
    }
  }
}
