import { create } from 'zustand'

export type PanelId = 'sidebar-left' | 'orchestrator-right'

export interface PanelLayout {
  width: number
  collapsed: boolean
}

export interface PanelLimits {
  minWidth: number
  maxWidth: number
  defaultWidth: number
}

export const PANEL_LIMITS = {
  'sidebar-left': { minWidth: 200, maxWidth: 480, defaultWidth: 300 },
  'orchestrator-right': { minWidth: 240, maxWidth: 560, defaultWidth: 360 }
} as const satisfies Record<PanelId, PanelLimits>

export const LAYOUT_STORAGE_KEY = 'vertragus.layout.v1'
/** Pre-rebrand key; read once as a fallback so existing layouts survive. */
export const LEGACY_LAYOUT_STORAGE_KEY = 'orca.layout.v1'

export type PanelLayouts = Record<PanelId, PanelLayout>

export interface LayoutStore {
  panels: PanelLayouts
  orchDrawerOpen: boolean
  terminalDrawerHeight: number
  setWidth: (id: PanelId, width: number) => void
  toggleCollapsed: (id: PanelId) => void
  collapse: (id: PanelId, collapsed: boolean) => void
  setOrchDrawerOpen: (open: boolean) => void
  toggleOrchDrawer: () => void
  setTerminalDrawerHeight: (height: number) => void
}

function createDefaultLayouts(): PanelLayouts {
  return {
    'sidebar-left': {
      width: PANEL_LIMITS['sidebar-left'].defaultWidth,
      collapsed: false
    },
    'orchestrator-right': {
      width: PANEL_LIMITS['orchestrator-right'].defaultWidth,
      collapsed: false
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function clampPanelWidth(id: PanelId, width: number): number {
  const limits = PANEL_LIMITS[id]
  if (!Number.isFinite(width)) return limits.defaultWidth
  return Math.min(limits.maxWidth, Math.max(limits.minWidth, width))
}

function parsePanelLayout(value: unknown, id: PanelId): PanelLayout {
  const defaults = createDefaultLayouts()[id]
  if (!isRecord(value)) return defaults

  return {
    width: typeof value.width === 'number' ? clampPanelWidth(id, value.width) : defaults.width,
    collapsed: typeof value.collapsed === 'boolean' ? value.collapsed : defaults.collapsed
  }
}

export function parsePersistedLayout(raw: string | null): PanelLayouts {
  if (raw === null) return createDefaultLayouts()

  try {
    const persisted: unknown = JSON.parse(raw)
    if (!isRecord(persisted) || !isRecord(persisted.panels)) return createDefaultLayouts()

    return {
      'sidebar-left': parsePanelLayout(persisted.panels['sidebar-left'], 'sidebar-left'),
      'orchestrator-right': parsePanelLayout(
        persisted.panels['orchestrator-right'],
        'orchestrator-right'
      )
    }
  } catch {
    return createDefaultLayouts()
  }
}

function getLayoutStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

function loadLayouts(): PanelLayouts {
  const storage = getLayoutStorage()
  if (!storage) return createDefaultLayouts()

  try {
    return parsePersistedLayout(
      storage.getItem(LAYOUT_STORAGE_KEY) ?? storage.getItem(LEGACY_LAYOUT_STORAGE_KEY)
    )
  } catch {
    return createDefaultLayouts()
  }
}

function persistLayouts(panels: PanelLayouts): void {
  try {
    getLayoutStorage()?.setItem(LAYOUT_STORAGE_KEY, JSON.stringify({ panels }))
  } catch {
    // Layout persistence is best-effort; an unavailable storage must not break the renderer.
  }
}

export const useLayoutStore = create<LayoutStore>((set, get) => ({
  panels: loadLayouts(),
  orchDrawerOpen: false,
  terminalDrawerHeight: 45,
  setWidth: (id, width) => {
    set((state) => ({
      panels: {
        ...state.panels,
        [id]: { ...state.panels[id], width: clampPanelWidth(id, width) }
      }
    }))
    persistLayouts(get().panels)
  },
  toggleCollapsed: (id) => {
    set((state) => ({
      panels: {
        ...state.panels,
        [id]: { ...state.panels[id], collapsed: !state.panels[id].collapsed }
      }
    }))
    persistLayouts(get().panels)
  },
  collapse: (id, collapsed) => {
    set((state) => ({
      panels: {
        ...state.panels,
        [id]: { ...state.panels[id], collapsed }
      }
    }))
    persistLayouts(get().panels)
  },
  setOrchDrawerOpen: (orchDrawerOpen) => set({ orchDrawerOpen }),
  toggleOrchDrawer: () => set((state) => ({ orchDrawerOpen: !state.orchDrawerOpen })),
  setTerminalDrawerHeight: (height) =>
    set({ terminalDrawerHeight: Math.min(75, Math.max(28, Number.isFinite(height) ? height : 45)) })
}))

export const selectPanelLayout =
  (id: PanelId) =>
  (state: LayoutStore): PanelLayout =>
    state.panels[id]

export const selectPanelWidth =
  (id: PanelId) =>
  (state: LayoutStore): number =>
    state.panels[id].width

export const selectPanelCollapsed =
  (id: PanelId) =>
  (state: LayoutStore): boolean =>
    state.panels[id].collapsed
