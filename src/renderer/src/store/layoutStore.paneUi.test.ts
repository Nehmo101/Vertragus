import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()

  get length(): number {
    return this.values.size
  }

  clear(): void {
    this.values.clear()
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

let storage: MemoryStorage

beforeEach(() => {
  vi.resetModules()
  storage = new MemoryStorage()
  vi.stubGlobal('localStorage', storage)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('canvas auto-collapse flag', () => {
  it('defaults to false and migrates older payloads without the key', async () => {
    storage.setItem(
      'vertragus.layout.v1',
      JSON.stringify({
        panels: {
          'sidebar-left': { width: 320, collapsed: false },
          'orchestrator-right': { width: 360, collapsed: false }
        }
      })
    )

    const { useLayoutStore } = await import('./layoutStore')
    expect(useLayoutStore.getState().canvasAutoCollapseDone).toBe(false)
  })

  it('persists once marked and survives a reload', async () => {
    const firstLoad = await import('./layoutStore')
    firstLoad.useLayoutStore.getState().markCanvasAutoCollapseDone()
    expect(firstLoad.useLayoutStore.getState().canvasAutoCollapseDone).toBe(true)

    vi.resetModules()
    const secondLoad = await import('./layoutStore')
    expect(secondLoad.useLayoutStore.getState().canvasAutoCollapseDone).toBe(true)
  })

  it('does not pollute the payload while unset (legacy shape stays intact)', async () => {
    const { useLayoutStore, LAYOUT_STORAGE_KEY } = await import('./layoutStore')
    useLayoutStore.getState().setWidth('sidebar-left', 340)

    const persisted = JSON.parse(storage.getItem(LAYOUT_STORAGE_KEY) ?? '{}') as Record<
      string,
      unknown
    >
    expect('canvasAutoCollapseDone' in persisted).toBe(false)
    expect('paneFontSizes' in persisted).toBe(false)
  })

  it('parses malformed payloads defensively', async () => {
    const { parsePersistedCanvasFlag } = await import('./layoutStore')
    expect(parsePersistedCanvasFlag(null)).toBe(false)
    expect(parsePersistedCanvasFlag('{not-json')).toBe(false)
    expect(parsePersistedCanvasFlag(JSON.stringify({ canvasAutoCollapseDone: 'yes' }))).toBe(false)
    expect(parsePersistedCanvasFlag(JSON.stringify({ canvasAutoCollapseDone: true }))).toBe(true)
  })
})

describe('pane font sizes', () => {
  it('clamps into the 8–20 window and falls back to the default', async () => {
    const { clampPaneFontSize, PANE_FONT_DEFAULT } = await import('./layoutStore')
    expect(clampPaneFontSize(7)).toBe(8)
    expect(clampPaneFontSize(8)).toBe(8)
    expect(clampPaneFontSize(20)).toBe(20)
    expect(clampPaneFontSize(21)).toBe(20)
    expect(clampPaneFontSize(13.4)).toBe(13)
    expect(clampPaneFontSize(Number.NaN)).toBe(PANE_FONT_DEFAULT)
    expect(clampPaneFontSize(Number.POSITIVE_INFINITY)).toBe(PANE_FONT_DEFAULT)
  })

  it('stores per agent, resolves defaults and resets per agent', async () => {
    const { useLayoutStore, paneFontSize, PANE_FONT_DEFAULT } = await import('./layoutStore')
    const store = useLayoutStore.getState()

    expect(paneFontSize(useLayoutStore.getState(), 'agent-a')).toBe(PANE_FONT_DEFAULT)

    store.setPaneFontSize('agent-a', 14)
    store.setPaneFontSize('agent-b', 99)
    expect(paneFontSize(useLayoutStore.getState(), 'agent-a')).toBe(14)
    expect(paneFontSize(useLayoutStore.getState(), 'agent-b')).toBe(20)

    store.resetPaneFontSize('agent-a')
    expect(paneFontSize(useLayoutStore.getState(), 'agent-a')).toBe(PANE_FONT_DEFAULT)
    expect(paneFontSize(useLayoutStore.getState(), 'agent-b')).toBe(20)
  })

  it('round-trips through localStorage and drops invalid persisted entries', async () => {
    const firstLoad = await import('./layoutStore')
    firstLoad.useLayoutStore.getState().setPaneFontSize('agent-a', 16)

    vi.resetModules()
    const secondLoad = await import('./layoutStore')
    expect(secondLoad.useLayoutStore.getState().paneFontSizes).toEqual({ 'agent-a': 16 })

    const { parsePersistedPaneFontSizes } = secondLoad
    expect(
      parsePersistedPaneFontSizes(
        JSON.stringify({ paneFontSizes: { a: 12, b: 'big', c: null, d: 999 } })
      )
    ).toEqual({ a: 12, d: 20 })
    expect(parsePersistedPaneFontSizes('{not-json')).toEqual({})
    expect(parsePersistedPaneFontSizes(null)).toEqual({})
  })
})
