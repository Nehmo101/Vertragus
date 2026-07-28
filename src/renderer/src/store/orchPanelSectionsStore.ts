import { create } from 'zustand'

/**
 * Persistent open/closed state for the collapsible sections of the right-hand
 * orchestrator panel. Deliberately separate from the layout store: this state
 * belongs to the panel alone and uses its own storage key, so neither payload
 * format can break the other.
 */

/** Every collapsible section of the orchestrator panel, in render order. */
export type OrchSectionId =
  | 'limits'
  | 'overview'
  | 'retro'
  | 'live'
  | 'findings'
  | 'tasks'
  | 'dispatch'

export const ORCH_SECTIONS_STORAGE_KEY = 'vertragus.orchpanel.v1'

/**
 * Defaults chosen for a working session: goal/status, live activity, findings
 * and the task DAG stay visible; limits, retro knowledge and the dispatch log
 * are reference material and start collapsed.
 */
export const SECTION_DEFAULT_OPEN: Record<OrchSectionId, boolean> = {
  limits: false,
  overview: true,
  retro: false,
  live: true,
  findings: true,
  tasks: true,
  dispatch: false
}

export const ORCH_SECTION_IDS = Object.keys(SECTION_DEFAULT_OPEN) as OrchSectionId[]

/**
 * The plan-review gate (approve/reject) renders above all sections, so it can
 * never be hidden by collapsing. Additionally, while a plan waits for review
 * the task section is forced open so the plan's task materialization is
 * visible the moment it is approved.
 */
export const PLAN_GATE_SECTION: OrchSectionId = 'tasks'

/** Sparse user overrides; missing entries fall back to SECTION_DEFAULT_OPEN. */
export type OrchSectionOpenState = Partial<Record<OrchSectionId, boolean>>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parses a persisted payload; unknown keys and non-boolean values are dropped. */
export function parsePersistedSections(raw: string | null): OrchSectionOpenState {
  if (raw === null) return {}
  try {
    const persisted: unknown = JSON.parse(raw)
    if (!isRecord(persisted) || !isRecord(persisted.sections)) return {}
    const sections: OrchSectionOpenState = {}
    for (const id of ORCH_SECTION_IDS) {
      const value = persisted.sections[id]
      if (typeof value === 'boolean') sections[id] = value
    }
    return sections
  } catch {
    return {}
  }
}

/**
 * Effective visibility of one section: user override, else default — but a
 * waiting plan always forces the plan-gate section open (pure, testable rule).
 */
export function resolveSectionOpen(
  sections: OrchSectionOpenState,
  id: OrchSectionId,
  planPending = false
): boolean {
  if (planPending && id === PLAN_GATE_SECTION) return true
  return sections[id] ?? SECTION_DEFAULT_OPEN[id]
}

function getStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

function loadSections(): OrchSectionOpenState {
  const storage = getStorage()
  if (!storage) return {}
  try {
    return parsePersistedSections(storage.getItem(ORCH_SECTIONS_STORAGE_KEY))
  } catch {
    return {}
  }
}

function persistSections(sections: OrchSectionOpenState): void {
  try {
    getStorage()?.setItem(ORCH_SECTIONS_STORAGE_KEY, JSON.stringify({ sections }))
  } catch {
    // Best-effort: an unavailable storage must never break the panel.
  }
}

export interface OrchPanelSectionsStore {
  sections: OrchSectionOpenState
  toggleSection: (id: OrchSectionId) => void
  setSectionOpen: (id: OrchSectionId, open: boolean) => void
}

export const useOrchPanelSections = create<OrchPanelSectionsStore>((set, get) => ({
  sections: loadSections(),
  toggleSection: (id) => {
    set((state) => ({
      sections: { ...state.sections, [id]: !resolveSectionOpen(state.sections, id) }
    }))
    persistSections(get().sections)
  },
  setSectionOpen: (id, open) => {
    set((state) => ({ sections: { ...state.sections, [id]: open } }))
    persistSections(get().sections)
  }
}))
