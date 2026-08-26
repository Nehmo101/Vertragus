import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PendingQuestions } from '@main/mcp/pendingQuestions'
import {
  armPanelAttention,
  attentionOverlayPng,
  PANEL_ATTENTION_REARM_MS,
  type DockBounce,
  type FlashableWindow,
  type OverlayIcon
} from './panelAttention'

class FakeWindow implements FlashableWindow {
  destroyed = false
  readonly flash: boolean[] = []
  readonly overlays: { image: unknown; description: string }[] = []
  focused = true

  isDestroyed(): boolean {
    return this.destroyed
  }
  flashFrame(flag: boolean): void {
    this.flash.push(flag)
  }
  setOverlayIcon(overlay: unknown | null, description: string): void {
    this.overlays.push({ image: overlay, description })
  }
  /** Attention must not consult focus — calling this fails the test. */
  isFocused(): boolean {
    throw new Error('panel attention must not consult isFocused')
  }
  focus(): void {
    throw new Error('panel attention must not steal focus')
  }
}

class FakeDock implements DockBounce {
  readonly log: string[] = []
  private nextId = 1

  bounce(type?: 'critical' | 'informational'): number {
    const id = this.nextId++
    this.log.push(`bounce:${type ?? 'default'}:${id}`)
    return id
  }
  cancelBounce(id: number): void {
    this.log.push(`cancel:${id}`)
  }
}

const OVERLAY_IMAGE = { kind: 'overlay' as const }

function overlay(): OverlayIcon {
  return { image: OVERLAY_IMAGE, description: () => 'Open question' }
}

function registry(): PendingQuestions {
  let n = 0
  return new PendingQuestions(
    () => `q${++n}`,
    () => 1000 + n
  )
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('armPanelAttention', () => {
  it('flashes the panel and shows the overlay while a question is open, including when focused', () => {
    const questions = registry()
    const panel = new FakeWindow()
    panel.focused = true
    const dock = new FakeDock()
    const cli = new FakeWindow()

    const dispose = armPanelAttention({
      window: () => panel,
      dock: () => dock,
      overlay: overlay(),
      openCount: () => questions.openCount,
      onChange: (listener) => questions.onMutate(listener)
    })

    expect(panel.flash).toEqual([])
    expect(panel.overlays).toEqual([])
    expect(cli.flash).toEqual([])
    expect(cli.overlays).toEqual([])

    questions.create('user', 'Ship it?')

    expect(panel.flash).toEqual([false, true])
    expect(panel.overlays).toEqual([{ image: OVERLAY_IMAGE, description: 'Open question' }])
    expect(dock.log).toEqual(['bounce:informational:1'])
    expect(cli.flash).toEqual([])
    expect(cli.overlays).toEqual([])
    expect(panel.focused).toBe(true)

    dispose()
  })

  it('toggles the overlay on the re-arm interval without consulting isFocused or calling focus', () => {
    const questions = registry()
    const panel = new FakeWindow()
    const dock = new FakeDock()

    const dispose = armPanelAttention({
      window: () => panel,
      dock: () => dock,
      overlay: overlay(),
      openCount: () => questions.openCount,
      onChange: (listener) => questions.onMutate(listener)
    })

    questions.create('a1', 'which db?')
    expect(panel.overlays).toEqual([{ image: OVERLAY_IMAGE, description: 'Open question' }])
    panel.flash.length = 0
    panel.overlays.length = 0
    dock.log.length = 0

    vi.advanceTimersByTime(PANEL_ATTENTION_REARM_MS)
    expect(panel.flash).toEqual([false, true])
    expect(panel.overlays).toEqual([{ image: null, description: '' }])
    expect(dock.log).toEqual(['cancel:1', 'bounce:informational:2'])

    vi.advanceTimersByTime(PANEL_ATTENTION_REARM_MS)
    expect(panel.flash).toEqual([false, true, false, true])
    expect(panel.overlays).toEqual([
      { image: null, description: '' },
      { image: OVERLAY_IMAGE, description: 'Open question' }
    ])

    dispose()
  })

  it('stops flashing and clears the overlay only when no questions remain', () => {
    const questions = registry()
    const panel = new FakeWindow()
    const dock = new FakeDock()

    const dispose = armPanelAttention({
      window: () => panel,
      dock: () => dock,
      overlay: overlay(),
      openCount: () => questions.openCount,
      onChange: (listener) => questions.onMutate(listener)
    })

    const first = questions.create('user', 'Ship it?')
    const second = questions.create('a1', 'which db?')
    panel.flash.length = 0
    panel.overlays.length = 0
    dock.log.length = 0

    questions.answer(first.questionId, 'yes')
    // One still open — must not stop.
    expect(panel.flash).toEqual([])
    expect(panel.overlays).toEqual([])
    expect(dock.log).toEqual([])

    questions.answer(second.questionId, 'postgres')
    expect(panel.flash).toEqual([false])
    expect(panel.overlays).toEqual([{ image: null, description: '' }])
    expect(dock.log).toEqual(['cancel:1'])

    panel.flash.length = 0
    panel.overlays.length = 0
    vi.advanceTimersByTime(PANEL_ATTENTION_REARM_MS * 2)
    expect(panel.flash).toEqual([])
    expect(panel.overlays).toEqual([])

    dispose()
  })

  it('is a no-op when the panel window is missing or destroyed, then resumes', () => {
    const questions = registry()
    const panel = new FakeWindow()
    let current: FakeWindow | null = null

    const dispose = armPanelAttention({
      window: () => current,
      overlay: overlay(),
      openCount: () => questions.openCount,
      onChange: (listener) => questions.onMutate(listener)
    })

    questions.create('user', 'Still there?')
    expect(panel.flash).toEqual([])
    expect(panel.overlays).toEqual([])

    current = panel
    vi.advanceTimersByTime(PANEL_ATTENTION_REARM_MS)
    expect(panel.flash).toEqual([false, true])
    expect(panel.overlays).toEqual([{ image: OVERLAY_IMAGE, description: 'Open question' }])

    panel.destroyed = true
    panel.flash.length = 0
    panel.overlays.length = 0
    vi.advanceTimersByTime(PANEL_ATTENTION_REARM_MS)
    expect(panel.flash).toEqual([])
    expect(panel.overlays).toEqual([])

    dispose()
  })

  it('stops on dispose even if a question is still open', () => {
    const questions = registry()
    const panel = new FakeWindow()

    const dispose = armPanelAttention({
      window: () => panel,
      overlay: overlay(),
      openCount: () => questions.openCount,
      onChange: (listener) => questions.onMutate(listener)
    })
    questions.create('user', 'Ship it?')
    panel.flash.length = 0
    panel.overlays.length = 0
    dispose()
    expect(panel.flash).toEqual([false])
    expect(panel.overlays).toEqual([{ image: null, description: '' }])

    panel.flash.length = 0
    panel.overlays.length = 0
    vi.advanceTimersByTime(PANEL_ATTENTION_REARM_MS * 2)
    expect(panel.flash).toEqual([])
    expect(panel.overlays).toEqual([])
  })
})

describe('attentionOverlayPng', () => {
  it('encodes a 16x16 PNG badge', () => {
    const png = attentionOverlayPng()
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    expect(png.length).toBeGreaterThan(32)
  })
})
