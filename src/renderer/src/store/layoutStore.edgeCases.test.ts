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

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('localStorage', new MemoryStorage())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('layoutStore edge cases', () => {
  it('clamps both panels at and beyond their exact min/max boundaries', async () => {
    const { PANEL_LIMITS, clampPanelWidth } = await import('./layoutStore')

    for (const panelId of ['sidebar-left', 'orchestrator-right'] as const) {
      const limits = PANEL_LIMITS[panelId]

      expect(clampPanelWidth(panelId, limits.minWidth - 1)).toBe(limits.minWidth)
      expect(clampPanelWidth(panelId, limits.minWidth)).toBe(limits.minWidth)
      expect(clampPanelWidth(panelId, limits.maxWidth)).toBe(limits.maxWidth)
      expect(clampPanelWidth(panelId, limits.maxWidth + 1)).toBe(limits.maxWidth)
      expect(clampPanelWidth(panelId, Number.NaN)).toBe(limits.defaultWidth)
    }
  })

  it.each(['', '   ', 'null', '[]', '{}'])('uses defaults for empty/invalid storage %j', async (raw) => {
    const storage = localStorage as MemoryStorage
    storage.setItem('orca.layout.v1', raw)

    const { useLayoutStore } = await import('./layoutStore')

    expect(useLayoutStore.getState().panels).toEqual({
      'sidebar-left': { width: 300, collapsed: false },
      'orchestrator-right': { width: 360, collapsed: false }
    })
  })

  it('falls back to defaults when localStorage throws while reading', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('storage unavailable')
      }
    })

    const { useLayoutStore } = await import('./layoutStore')

    expect(useLayoutStore.getState().panels).toEqual({
      'sidebar-left': { width: 300, collapsed: false },
      'orchestrator-right': { width: 360, collapsed: false }
    })
  })

  it('ignores unknown persisted panel ids and defaults missing known panels', async () => {
    const { parsePersistedLayout } = await import('./layoutStore')

    expect(
      parsePersistedLayout(
        JSON.stringify({
          panels: {
            'sidebar-left': { width: 320, collapsed: true },
            'future-panel': { width: 999, collapsed: true }
          }
        })
      )
    ).toEqual({
      'sidebar-left': { width: 320, collapsed: true },
      'orchestrator-right': { width: 360, collapsed: false }
    })
  })

  it('keeps explicit collapse idempotent and makes two toggles a round trip', async () => {
    const { useLayoutStore } = await import('./layoutStore')
    const initial = useLayoutStore.getState().panels['sidebar-left'].collapsed

    useLayoutStore.getState().collapse('sidebar-left', true)
    useLayoutStore.getState().collapse('sidebar-left', true)
    expect(useLayoutStore.getState().panels['sidebar-left'].collapsed).toBe(true)

    useLayoutStore.getState().toggleCollapsed('sidebar-left')
    useLayoutStore.getState().toggleCollapsed('sidebar-left')
    expect(useLayoutStore.getState().panels['sidebar-left'].collapsed).toBe(true)

    useLayoutStore.getState().collapse('sidebar-left', initial)
    expect(useLayoutStore.getState().panels['sidebar-left'].collapsed).toBe(initial)
  })

  it('updates in-memory state even when localStorage throws while writing', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('storage is read-only')
      }
    })

    const { useLayoutStore } = await import('./layoutStore')

    expect(() => useLayoutStore.getState().setWidth('sidebar-left', 340)).not.toThrow()
    expect(useLayoutStore.getState().panels['sidebar-left'].width).toBe(340)
  })
})
