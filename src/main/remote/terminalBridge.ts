/**
 * One remote client's view of the terminals it is watching.
 *
 * Mirrors the desktop terminal IPC (`ipc.ts`): a snapshot on attach, then a
 * coalesced live stream, so a phone attaching gets the full scrollback and
 * never a duplicated chunk. Each client owns its own bridge, and each attach
 * is an independent {@link TerminalDirectory} subscription — a reconnecting
 * phone re-attaches from scratch and the lossless scrollback makes that whole.
 *
 * The coalescing (one frame) is the same reason it exists on the IPC side: a
 * chatty CLI emits dozens of tiny chunks a second, and each one crossing a
 * WebSocket as its own frame is pure overhead.
 */
import type { TerminalDirectory, TerminalSubscription } from '@main/ipc'
import type { ServerMessage } from '@shared/remote/protocol'

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
  attach(agentId: string): void
  detach(agentId: string): void
  input(agentId: string, data: string): void
  resize(agentId: string, cols: number, rows: number): void
  /** Detach everything — the client disconnected or the server is shutting down. */
  dispose(): void
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
    attach(agentId: string): void {
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
      // window uses, so the client can concatenate them without dedup.
      deps.send({
        type: 'snapshot',
        agentId,
        snapshot: subscription.snapshot,
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
