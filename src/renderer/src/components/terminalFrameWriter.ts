const MAX_PENDING_CHARS = 256 * 1024

export interface TerminalFrameWriter {
  write(data: string): void
  dispose(): void
}

/**
 * Coalesce PTY chunks into a single xterm write per rendered frame. Interactive
 * CLIs often split cursor movement, line clearing and replacement text across
 * several chunks; painting those intermediate states is perceived as flicker.
 */
export function createTerminalFrameWriter(
  sink: (data: string) => void,
  requestFrame: (callback: FrameRequestCallback) => number = requestAnimationFrame,
  cancelFrame: (handle: number) => void = cancelAnimationFrame
): TerminalFrameWriter {
  let pending = ''
  let frame: number | undefined
  let disposed = false

  const flush = (): void => {
    frame = undefined
    if (disposed || !pending) return
    const data = pending
    pending = ''
    sink(data)
  }

  return {
    write(data) {
      if (disposed || !data) return
      pending += data

      // Do not let a throttled/background renderer retain output without a
      // bound. xterm still performs its own ordered buffering for this flush.
      if (pending.length >= MAX_PENDING_CHARS) {
        if (frame != null) cancelFrame(frame)
        flush()
        return
      }

      if (frame == null) frame = requestFrame(flush)
    },
    dispose() {
      disposed = true
      pending = ''
      if (frame != null) cancelFrame(frame)
      frame = undefined
    }
  }
}
