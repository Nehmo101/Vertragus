import { describe, expect, it, vi } from 'vitest'
import { createTerminalFrameWriter } from './terminalFrameWriter'

describe('terminal frame writer', () => {
  it('renders a burst of PTY chunks as one complete frame', () => {
    const sink = vi.fn()
    let renderFrame: FrameRequestCallback | undefined
    const writer = createTerminalFrameWriter(
      sink,
      (callback) => {
        renderFrame = callback
        return 7
      },
      vi.fn()
    )

    writer.write('\u001b[2K\r')
    writer.write('updated prompt')

    expect(sink).not.toHaveBeenCalled()
    renderFrame?.(0)
    expect(sink).toHaveBeenCalledOnce()
    expect(sink).toHaveBeenCalledWith('\u001b[2K\rupdated prompt')
  })

  it('cancels a pending frame and output when disposed', () => {
    const sink = vi.fn()
    const cancelFrame = vi.fn()
    const writer = createTerminalFrameWriter(sink, () => 11, cancelFrame)

    writer.write('pending')
    writer.dispose()

    expect(cancelFrame).toHaveBeenCalledWith(11)
    expect(sink).not.toHaveBeenCalled()
  })
})
