import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ORCH_SECTIONS_STORAGE_KEY,
  ORCH_SECTION_IDS,
  PLAN_GATE_SECTION,
  SECTION_DEFAULT_OPEN,
  parsePersistedSections,
  resolveSectionOpen
} from './orchPanelSectionsStore'

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map<string, string>(Object.entries(initial))
  return {
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => void data.delete(key),
    setItem: (key: string, value: string) => void data.set(key, value)
  }
}

describe('parsePersistedSections', () => {
  it('returns no overrides for a missing payload', () => {
    expect(parsePersistedSections(null)).toEqual({})
  })

  it('returns no overrides for invalid JSON or wrong shapes', () => {
    expect(parsePersistedSections('{nope')).toEqual({})
    expect(parsePersistedSections('42')).toEqual({})
    expect(parsePersistedSections('[]')).toEqual({})
    expect(parsePersistedSections('{"sections":[]}')).toEqual({})
  })

  it('keeps only known section ids with boolean values', () => {
    const raw = JSON.stringify({
      sections: {
        limits: true,
        dispatch: false,
        unknownSection: true,
        tasks: 'yes'
      }
    })
    expect(parsePersistedSections(raw)).toEqual({ limits: true, dispatch: false })
  })

  it('round-trips every section id', () => {
    const all = Object.fromEntries(ORCH_SECTION_IDS.map((id) => [id, false]))
    const raw = JSON.stringify({ sections: all })
    expect(parsePersistedSections(raw)).toEqual(all)
  })
})

describe('resolveSectionOpen', () => {
  it('falls back to the documented defaults', () => {
    for (const id of ORCH_SECTION_IDS) {
      expect(resolveSectionOpen({}, id)).toBe(SECTION_DEFAULT_OPEN[id])
    }
    // Working set open, reference material closed.
    expect(resolveSectionOpen({}, 'overview')).toBe(true)
    expect(resolveSectionOpen({}, 'live')).toBe(true)
    expect(resolveSectionOpen({}, 'tasks')).toBe(true)
    expect(resolveSectionOpen({}, 'limits')).toBe(false)
    expect(resolveSectionOpen({}, 'retro')).toBe(false)
    expect(resolveSectionOpen({}, 'dispatch')).toBe(false)
  })

  it('honors user overrides in both directions', () => {
    expect(resolveSectionOpen({ limits: true }, 'limits')).toBe(true)
    expect(resolveSectionOpen({ live: false }, 'live')).toBe(false)
  })

  it('forces the plan-gate section open while a plan waits for review', () => {
    expect(resolveSectionOpen({ [PLAN_GATE_SECTION]: false }, PLAN_GATE_SECTION, true)).toBe(true)
    // Without a pending plan the stored preference wins again.
    expect(resolveSectionOpen({ [PLAN_GATE_SECTION]: false }, PLAN_GATE_SECTION, false)).toBe(false)
  })

  it('never forces unrelated sections open', () => {
    for (const id of ORCH_SECTION_IDS) {
      if (id === PLAN_GATE_SECTION) continue
      expect(resolveSectionOpen({ [id]: false }, id, true)).toBe(false)
    }
  })
})

describe('useOrchPanelSections store', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('hydrates from the persisted payload', async () => {
    const storage = memoryStorage({
      [ORCH_SECTIONS_STORAGE_KEY]: JSON.stringify({ sections: { dispatch: true, live: false } })
    })
    vi.stubGlobal('localStorage', storage)
    const { useOrchPanelSections } = await import('./orchPanelSectionsStore')
    expect(useOrchPanelSections.getState().sections).toEqual({ dispatch: true, live: false })
  })

  it('toggleSection flips from the default and persists the result', async () => {
    const storage = memoryStorage()
    vi.stubGlobal('localStorage', storage)
    const { useOrchPanelSections, resolveSectionOpen: resolve } = await import(
      './orchPanelSectionsStore'
    )
    const store = useOrchPanelSections.getState()

    store.toggleSection('limits') // default closed -> open
    store.toggleSection('tasks') // default open -> closed
    const state = useOrchPanelSections.getState().sections
    expect(resolve(state, 'limits')).toBe(true)
    expect(resolve(state, 'tasks')).toBe(false)

    const persisted = JSON.parse(storage.getItem(ORCH_SECTIONS_STORAGE_KEY) ?? '{}') as {
      sections?: Record<string, boolean>
    }
    expect(persisted.sections).toEqual({ limits: true, tasks: false })
  })

  it('setSectionOpen stores explicit values and survives a reload', async () => {
    const storage = memoryStorage()
    vi.stubGlobal('localStorage', storage)
    {
      const { useOrchPanelSections } = await import('./orchPanelSectionsStore')
      useOrchPanelSections.getState().setSectionOpen('retro', true)
    }
    vi.resetModules()
    {
      const { useOrchPanelSections } = await import('./orchPanelSectionsStore')
      expect(useOrchPanelSections.getState().sections.retro).toBe(true)
    }
  })

  it('works without any storage available', async () => {
    const { useOrchPanelSections } = await import('./orchPanelSectionsStore')
    expect(useOrchPanelSections.getState().sections).toEqual({})
    expect(() => useOrchPanelSections.getState().toggleSection('limits')).not.toThrow()
    expect(useOrchPanelSections.getState().sections.limits).toBe(true)
  })
})
