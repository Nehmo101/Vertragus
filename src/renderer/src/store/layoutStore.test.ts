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

describe('layoutStore persistence', () => {
  it('round-trips panel width and collapsed state through localStorage', async () => {
    const firstLoad = await import('./layoutStore')

    firstLoad.useLayoutStore.getState().setWidth('sidebar-left', 416)
    firstLoad.useLayoutStore.getState().collapse('orchestrator-right', true)

    expect(JSON.parse(storage.getItem(firstLoad.LAYOUT_STORAGE_KEY) ?? '')).toEqual({
      panels: {
        'sidebar-left': { width: 416, collapsed: false },
        'orchestrator-right': { width: 360, collapsed: true }
      }
    })

    vi.resetModules()
    const secondLoad = await import('./layoutStore')

    expect(secondLoad.useLayoutStore.getState().panels).toEqual({
      'sidebar-left': { width: 416, collapsed: false },
      'orchestrator-right': { width: 360, collapsed: true }
    })
  })

  it('keeps canvas drawer state bounded and session-local', async () => {
    const { useLayoutStore } = await import('./layoutStore')
    useLayoutStore.getState().setOrchDrawerOpen(true)
    useLayoutStore.getState().setTerminalDrawerHeight(99)
    expect(useLayoutStore.getState().orchDrawerOpen).toBe(true)
    expect(useLayoutStore.getState().terminalDrawerHeight).toBe(75)
  })

  it('clamps persisted widths to each panel limit while loading', async () => {
    storage.setItem(
      'orca.layout.v1',
      JSON.stringify({
        panels: {
          'sidebar-left': { width: 999, collapsed: true },
          'orchestrator-right': { width: -50, collapsed: false }
        }
      })
    )

    const { useLayoutStore } = await import('./layoutStore')

    expect(useLayoutStore.getState().panels).toEqual({
      'sidebar-left': { width: 480, collapsed: true },
      'orchestrator-right': { width: 240, collapsed: false }
    })
  })

  it('falls back to defaults for malformed or invalid persisted data', async () => {
    storage.setItem('orca.layout.v1', '{not-json')
    const malformedLoad = await import('./layoutStore')

    expect(malformedLoad.useLayoutStore.getState().panels).toEqual({
      'sidebar-left': { width: 300, collapsed: false },
      'orchestrator-right': { width: 360, collapsed: false }
    })

    vi.resetModules()
    storage.setItem(
      'orca.layout.v1',
      JSON.stringify({
        panels: {
          'sidebar-left': { width: 'wide', collapsed: 'yes' },
          'orchestrator-right': null
        }
      })
    )
    const invalidLoad = await import('./layoutStore')

    expect(invalidLoad.useLayoutStore.getState().panels).toEqual({
      'sidebar-left': { width: 300, collapsed: false },
      'orchestrator-right': { width: 360, collapsed: false }
    })
  })
})
