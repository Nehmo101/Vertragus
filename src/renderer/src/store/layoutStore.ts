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

/** xterm font size limits for agent panes (Strg/Cmd+Mausrad zoom). */
export const PANE_FONT_MIN = 8
export const PANE_FONT_MAX = 20
export const PANE_FONT_DEFAULT = 11

export interface LayoutStore {
  panels: PanelLayouts
  orchDrawerOpen: boolean
  terminalDrawerHeight: number
  /** True once the sidebar was auto-collapsed on the very first canvas visit. */
  canvasAutoCollapseDone: boolean
  /** Persisted xterm font size per agent pane, keyed by agent id. */
  paneFontSizes: Record<string, number>
  /**
   * Collapse state of the sidebar sections, keyed by section id. Only collapsed
   * sections are stored (`false`); a missing key means "open" (the default), so
   * older persisted payloads without this field stay valid.
   */
  sidebarSections: Record<string, boolean>
  setWidth: (id: PanelId, width: number) => void
  toggleCollapsed: (id: PanelId) => void
  collapse: (id: PanelId, collapsed: boolean) => void
  setOrchDrawerOpen: (open: boolean) => void
  toggleOrchDrawer: () => void
  setTerminalDrawerHeight: (height: number) => void
  markCanvasAutoCollapseDone: () => void
  setPaneFontSize: (agentId: string, size: number) => void
  resetPaneFontSize: (agentId: string) => void
  toggleSidebarSection: (sectionId: string) => void
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

/** Clamps a pane font size into the 8–20 px window; invalid input → default. */
export function clampPaneFontSize(size: number): number {
  if (!Number.isFinite(size)) return PANE_FONT_DEFAULT
  return Math.min(PANE_FONT_MAX, Math.max(PANE_FONT_MIN, Math.round(size)))
}

/** Effective xterm font size for an agent pane (default when unset). */
export function paneFontSize(state: Pick<LayoutStore, 'paneFontSizes'>, agentId: string): number {
  const stored = state.paneFontSizes[agentId]
  return stored == null ? PANE_FONT_DEFAULT : clampPaneFontSize(stored)
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

/**
 * Reads the persisted first-canvas-visit flag. Older payloads (or the legacy
 * `orca.layout.v1` format) simply lack the key and migrate to `false`.
 */
export function parsePersistedCanvasFlag(raw: string | null): boolean {
  if (raw === null) return false
  try {
    const persisted: unknown = JSON.parse(raw)
    return isRecord(persisted) && persisted.canvasAutoCollapseDone === true
  } catch {
    return false
  }
}

/** Reads persisted per-pane font sizes; unknown/invalid entries are dropped. */
export function parsePersistedPaneFontSizes(raw: string | null): Record<string, number> {
  if (raw === null) return {}
  try {
    const persisted: unknown = JSON.parse(raw)
    if (!isRecord(persisted) || !isRecord(persisted.paneFontSizes)) return {}
    const sizes: Record<string, number> = {}
    for (const [agentId, size] of Object.entries(persisted.paneFontSizes)) {
      if (typeof size === 'number' && Number.isFinite(size)) {
        sizes[agentId] = clampPaneFontSize(size)
      }
    }
    return sizes
  } catch {
    return {}
  }
}

/**
 * Reads persisted sidebar-section collapse states. Only explicit `false`
 * (collapsed) entries are kept — `true` equals the "open" default and would
 * only bloat the payload; non-boolean values are dropped defensively.
 */
export function parsePersistedSidebarSections(raw: string | null): Record<string, boolean> {
  if (raw === null) return {}
  try {
    const persisted: unknown = JSON.parse(raw)
    if (!isRecord(persisted) || !isRecord(persisted.sidebarSections)) return {}
    const sections: Record<string, boolean> = {}
    for (const [sectionId, open] of Object.entries(persisted.sidebarSections)) {
      if (open === false) sections[sectionId] = false
    }
    return sections
  } catch {
    return {}
  }
}

/** Whether one sidebar section is open; missing entries default to open. */
export function sidebarSectionOpen(
  state: Pick<LayoutStore, 'sidebarSections'>,
  sectionId: string
): boolean {
  return state.sidebarSections[sectionId] !== false
}

function getLayoutStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

interface PersistedLayoutState {
  panels: PanelLayouts
  canvasAutoCollapseDone: boolean
  paneFontSizes: Record<string, number>
  sidebarSections: Record<string, boolean>
}

function loadLayouts(): PersistedLayoutState {
  const defaults: PersistedLayoutState = {
    panels: createDefaultLayouts(),
    canvasAutoCollapseDone: false,
    paneFontSizes: {},
    sidebarSections: {}
  }
  const storage = getLayoutStorage()
  if (!storage) return defaults

  try {
    const raw = storage.getItem(LAYOUT_STORAGE_KEY) ?? storage.getItem(LEGACY_LAYOUT_STORAGE_KEY)
    return {
      panels: parsePersistedLayout(raw),
      canvasAutoCollapseDone: parsePersistedCanvasFlag(raw),
      paneFontSizes: parsePersistedPaneFontSizes(raw),
      sidebarSections: parsePersistedSidebarSections(raw)
    }
  } catch {
    return defaults
  }
}

function persistLayouts(state: PersistedLayoutState): void {
  try {
    // Optional keys are written only when set, so pre-existing payload shapes
    // (and their consumers) keep round-tripping unchanged.
    const payload: Record<string, unknown> = { panels: state.panels }
    if (state.canvasAutoCollapseDone) payload.canvasAutoCollapseDone = true
    if (Object.keys(state.paneFontSizes).length > 0) payload.paneFontSizes = state.paneFontSizes
    if (Object.keys(state.sidebarSections).length > 0) payload.sidebarSections = state.sidebarSections
    getLayoutStorage()?.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(payload))
  } catch {
    // Layout persistence is best-effort; an unavailable storage must not break the renderer.
  }
}

export const useLayoutStore = create<LayoutStore>((set, get) => ({
  ...loadLayouts(),
  orchDrawerOpen: false,
  terminalDrawerHeight: 45,
  setWidth: (id, width) => {
    set((state) => ({
      panels: {
        ...state.panels,
        [id]: { ...state.panels[id], width: clampPanelWidth(id, width) }
      }
    }))
    persistLayouts(get())
  },
  toggleCollapsed: (id) => {
    set((state) => ({
      panels: {
        ...state.panels,
        [id]: { ...state.panels[id], collapsed: !state.panels[id].collapsed }
      }
    }))
    persistLayouts(get())
  },
  collapse: (id, collapsed) => {
    set((state) => ({
      panels: {
        ...state.panels,
        [id]: { ...state.panels[id], collapsed }
      }
    }))
    persistLayouts(get())
  },
  setOrchDrawerOpen: (orchDrawerOpen) => set({ orchDrawerOpen }),
  toggleOrchDrawer: () => set((state) => ({ orchDrawerOpen: !state.orchDrawerOpen })),
  setTerminalDrawerHeight: (height) =>
    set({ terminalDrawerHeight: Math.min(75, Math.max(28, Number.isFinite(height) ? height : 45)) }),
  markCanvasAutoCollapseDone: () => {
    if (get().canvasAutoCollapseDone) return
    set({ canvasAutoCollapseDone: true })
    persistLayouts(get())
  },
  setPaneFontSize: (agentId, size) => {
    set((state) => ({
      paneFontSizes: { ...state.paneFontSizes, [agentId]: clampPaneFontSize(size) }
    }))
    persistLayouts(get())
  },
  resetPaneFontSize: (agentId) => {
    set((state) => {
      if (!(agentId in state.paneFontSizes)) return state
      const next = { ...state.paneFontSizes }
      delete next[agentId]
      return { paneFontSizes: next }
    })
    persistLayouts(get())
  },
  toggleSidebarSection: (sectionId) => {
    set((state) => {
      const next = { ...state.sidebarSections }
      // Open is the default: re-opening removes the key instead of storing `true`.
      if (next[sectionId] === false) delete next[sectionId]
      else next[sectionId] = false
      return { sidebarSections: next }
    })
    persistLayouts(get())
  }
}))

export const selectPanelLayout =
  (id: PanelId) =>
  (state: LayoutStore): PanelLayout =>
    state.panels[id]

export const selectPanelWidth =
  (id: PanelId) =>
  (state: LayoutStore): number =>
    state.panels[id].width
