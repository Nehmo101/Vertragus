import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getAttentionStateForTest,
  initAttentionService,
  resetAttentionServiceForTest,
  setPendingFeedbackCount,
  type AttentionDockLike,
  type AttentionWindowLike
} from './attentionService'

vi.mock('electron', () => ({
  app: { dock: null }
}))

class FakeWindow extends EventEmitter implements AttentionWindowLike {
  focused = false
  destroyed = false
  flashFrame = vi.fn()

  isFocused(): boolean {
    return this.focused
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  destroy(): void {
    this.destroyed = true
    this.emit('closed')
  }
}

function createDock(): AttentionDockLike & { bounce: ReturnType<typeof vi.fn>; cancelBounce: ReturnType<typeof vi.fn> } {
  let nextId = 1
  return {
    bounce: vi.fn(() => nextId++),
    cancelBounce: vi.fn()
  }
}

describe('attentionService', () => {
  let win: FakeWindow

  beforeEach(() => {
    resetAttentionServiceForTest()
    win = new FakeWindow()
  })

  afterEach(() => {
    resetAttentionServiceForTest()
  })

  it('starts flashFrame on Windows when count goes 0 → >0 while unfocused', () => {
    initAttentionService({
      getMainWindow: () => win,
      platform: 'win32',
      dock: null
    })

    setPendingFeedbackCount(2)

    expect(win.flashFrame).toHaveBeenCalledWith(true)
    expect(getAttentionStateForTest()).toMatchObject({
      pendingCount: 2,
      flashing: true,
      bounceId: null
    })
  })

  it('bounces the dock on macOS instead of flashing the frame', () => {
    const dock = createDock()
    initAttentionService({
      getMainWindow: () => win,
      platform: 'darwin',
      dock
    })

    setPendingFeedbackCount(1)

    expect(dock.bounce).toHaveBeenCalledWith('critical')
    expect(win.flashFrame).not.toHaveBeenCalledWith(true)
    expect(getAttentionStateForTest().flashing).toBe(true)
    expect(getAttentionStateForTest().bounceId).toBe(1)
  })

  it('is idempotent: repeated >0 counts do not start a second blink', () => {
    initAttentionService({
      getMainWindow: () => win,
      platform: 'linux',
      dock: null
    })

    setPendingFeedbackCount(1)
    setPendingFeedbackCount(3)
    setPendingFeedbackCount(5)

    expect(win.flashFrame).toHaveBeenCalledTimes(1)
    expect(win.flashFrame).toHaveBeenCalledWith(true)
    expect(getAttentionStateForTest()).toMatchObject({ pendingCount: 5, flashing: true })
  })

  it('does not start attention when the window is already focused', () => {
    win.focused = true
    initAttentionService({
      getMainWindow: () => win,
      platform: 'win32',
      dock: null
    })

    setPendingFeedbackCount(1)

    expect(win.flashFrame).not.toHaveBeenCalled()
    expect(getAttentionStateForTest().flashing).toBe(false)
  })

  it('stops flashing when the count falls to 0', () => {
    initAttentionService({
      getMainWindow: () => win,
      platform: 'win32',
      dock: null
    })
    setPendingFeedbackCount(1)
    win.flashFrame.mockClear()

    setPendingFeedbackCount(0)

    expect(win.flashFrame).toHaveBeenCalledWith(false)
    expect(getAttentionStateForTest()).toMatchObject({ pendingCount: 0, flashing: false })
  })

  it('stops and cancels dock bounce on focus, then allows a fresh 0 → >0 trigger', () => {
    const dock = createDock()
    initAttentionService({
      getMainWindow: () => win,
      platform: 'darwin',
      dock
    })
    setPendingFeedbackCount(1)
    expect(getAttentionStateForTest().bounceId).toBe(1)

    win.focused = true
    win.emit('focus')

    expect(dock.cancelBounce).toHaveBeenCalledWith(1)
    expect(getAttentionStateForTest().flashing).toBe(false)

    // Still pending, but focus already cleared attention — only a new 0→>0 fires again.
    win.focused = false
    setPendingFeedbackCount(2)
    expect(dock.bounce).toHaveBeenCalledTimes(1)

    setPendingFeedbackCount(0)
    setPendingFeedbackCount(1)
    expect(dock.bounce).toHaveBeenCalledTimes(2)
    expect(getAttentionStateForTest().flashing).toBe(true)
  })

  it('cleans up the focus listener when the window is destroyed', () => {
    initAttentionService({
      getMainWindow: () => win,
      platform: 'win32',
      dock: null
    })
    setPendingFeedbackCount(1)
    expect(win.listenerCount('focus')).toBe(1)

    win.destroy()

    expect(win.listenerCount('focus')).toBe(0)
    expect(win.listenerCount('closed')).toBe(0)
  })

  it('tolerates a null or destroyed main window without throwing', () => {
    initAttentionService({
      getMainWindow: () => null,
      platform: 'win32',
      dock: null
    })
    expect(() => setPendingFeedbackCount(1)).not.toThrow()
    expect(getAttentionStateForTest().flashing).toBe(false)

    win.destroyed = true
    initAttentionService({
      getMainWindow: () => win,
      platform: 'win32',
      dock: null
    })
    expect(() => setPendingFeedbackCount(2)).not.toThrow()
    expect(getAttentionStateForTest().flashing).toBe(false)
  })

  it('normalizes non-finite and negative counts to zero and stops attention', () => {
    initAttentionService({
      getMainWindow: () => win,
      platform: 'win32',
      dock: null
    })
    setPendingFeedbackCount(1)
    win.flashFrame.mockClear()

    setPendingFeedbackCount(Number.NaN)
    expect(getAttentionStateForTest().pendingCount).toBe(0)
    expect(win.flashFrame).toHaveBeenCalledWith(false)

    setPendingFeedbackCount(1)
    win.flashFrame.mockClear()
    setPendingFeedbackCount(-3)
    expect(getAttentionStateForTest().pendingCount).toBe(0)
    expect(getAttentionStateForTest().flashing).toBe(false)
  })
})
