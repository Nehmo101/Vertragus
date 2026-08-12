import { describe, expect, it, vi } from 'vitest'

/**
 * The capture path is the only thing standing between "the panel renders" and a
 * green CI, so its retry and give-up behaviour is tested directly — with a fake
 * window, because the whole point is the cases where a real capture fails.
 */
const exit = vi.fn()
vi.mock('electron', () => ({ app: { exit: (code: number) => exit(code) } }))

const { armWindowCapture, captureWindowToFile, PAINTED_PROBE } = await import('./smokeCapture')

interface FakeOptions {
  /** How many capture attempts fail before one succeeds; Infinity = never. */
  failCaptures?: number
  /** Mounted child count reported by the paint probe, per poll. */
  mounted?: number[]
  visible?: boolean
  emptyImage?: boolean
}

function fakeWindow(options: FakeOptions = {}) {
  const { failCaptures = 0, mounted = [1], visible = true, emptyImage = false } = options
  let captureCalls = 0
  let paintCalls = 0
  const state = {
    visible,
    destroyed: false,
    shows: 0,
    get captureCalls() {
      return captureCalls
    },
    loadHandlers: [] as (() => void)[]
  }
  const win = {
    isDestroyed: () => state.destroyed,
    isVisible: () => state.visible,
    show: () => {
      state.shows += 1
      state.visible = true
    },
    webContents: {
      once: (_event: 'did-finish-load', listener: () => void) => state.loadHandlers.push(listener),
      executeJavaScript: async (code: string) => {
        expect(code).toBe(PAINTED_PROBE)
        const value = mounted[Math.min(paintCalls, mounted.length - 1)]
        paintCalls += 1
        return value
      },
      capturePage: async () => {
        captureCalls += 1
        if (captureCalls <= failCaptures) throw new Error('UnknownVizError')
        return { isEmpty: () => emptyImage, toPNG: () => Buffer.from('png-bytes') }
      }
    }
  }
  return { win, state }
}

const noWait = { wait: async () => {}, log: () => {} }

describe('captureWindowToFile', () => {
  it('writes the capture and reports success', async () => {
    const written: [string, Buffer][] = []
    const { win, state } = fakeWindow()
    const ok = await captureWindowToFile(win, '/tmp/panel.png', 'panel', {
      ...noWait,
      writeFile: async (path, data) => {
        written.push([path, data])
      }
    })
    expect(ok).toBe(true)
    expect(written).toHaveLength(1)
    expect(written[0][0]).toBe('/tmp/panel.png')
    expect(state.captureCalls).toBe(1)
  })

  it('shows a window that is still hidden — an unmapped window has nothing to copy', async () => {
    const { win, state } = fakeWindow({ visible: false })
    await captureWindowToFile(win, '/tmp/panel.png', 'panel', { ...noWait, writeFile: async () => {} })
    expect(state.shows).toBeGreaterThan(0)
  })

  it('retries a capture that fails while the viz process is still coming up', async () => {
    const { win, state } = fakeWindow({ failCaptures: 3 })
    const ok = await captureWindowToFile(win, '/tmp/panel.png', 'panel', {
      ...noWait,
      writeFile: async () => {}
    })
    expect(ok).toBe(true)
    expect(state.captureCalls).toBe(4)
  })

  it('gives up after the configured number of attempts instead of hanging', async () => {
    const { win, state } = fakeWindow({ failCaptures: Number.POSITIVE_INFINITY })
    const ok = await captureWindowToFile(win, '/tmp/panel.png', 'panel', {
      ...noWait,
      attempts: 3,
      writeFile: async () => {}
    })
    expect(ok).toBe(false)
    expect(state.captureCalls).toBe(3)
  })

  it('treats an empty image as a failed capture, not as a capture', async () => {
    const { win } = fakeWindow({ emptyImage: true })
    const written: string[] = []
    const ok = await captureWindowToFile(win, '/tmp/panel.png', 'panel', {
      ...noWait,
      attempts: 2,
      writeFile: async (path) => {
        written.push(path)
      }
    })
    expect(ok).toBe(false)
    expect(written).toEqual([])
  })

  // The reason this smoke exists: a CSP violation or a broken preload leaves an
  // empty #root, and that must fail loudly rather than produce a blank PNG.
  it('fails when the renderer never mounts anything into #root', async () => {
    const { win, state } = fakeWindow({ mounted: [0] })
    const ok = await captureWindowToFile(win, '/tmp/panel.png', 'panel', {
      ...noWait,
      paintAttempts: 4,
      writeFile: async () => {}
    })
    expect(ok).toBe(false)
    expect(state.captureCalls).toBe(0)
  })

  it('waits for a renderer that mounts late', async () => {
    const { win, state } = fakeWindow({ mounted: [0, 0, 2] })
    const ok = await captureWindowToFile(win, '/tmp/panel.png', 'panel', {
      ...noWait,
      paintAttempts: 5,
      writeFile: async () => {}
    })
    expect(ok).toBe(true)
    expect(state.captureCalls).toBe(1)
  })

  it('refuses a window that is already gone', async () => {
    const { win, state } = fakeWindow()
    state.destroyed = true
    const ok = await captureWindowToFile(win, '/tmp/panel.png', 'panel', {
      ...noWait,
      writeFile: async () => {}
    })
    expect(ok).toBe(false)
    expect(state.captureCalls).toBe(0)
  })
})

describe('armWindowCapture', () => {
  it('is inert without its env var', () => {
    const { win, state } = fakeWindow()
    delete process.env['VERTRAGUS_TEST_SCREENSHOT']
    armWindowCapture(win, 'VERTRAGUS_TEST_SCREENSHOT', 'test', 0)
    expect(state.loadHandlers).toHaveLength(0)
  })

  it('exits 1 when the capture never succeeds', async () => {
    exit.mockClear()
    vi.useFakeTimers()
    try {
      const { win, state } = fakeWindow({ failCaptures: Number.POSITIVE_INFINITY })
      process.env['VERTRAGUS_TEST_SCREENSHOT'] = '/tmp/test.png'
      armWindowCapture(win, 'VERTRAGUS_TEST_SCREENSHOT', 'test', 0, {
        ...noWait,
        attempts: 2,
        writeFile: async () => {}
      })
      expect(state.loadHandlers).toHaveLength(1)
      state.loadHandlers[0]()
      await vi.advanceTimersByTimeAsync(1)
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1))
    } finally {
      vi.useRealTimers()
      delete process.env['VERTRAGUS_TEST_SCREENSHOT']
    }
  })
})
