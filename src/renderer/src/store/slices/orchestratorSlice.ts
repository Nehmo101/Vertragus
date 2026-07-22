/** Orchestrator snapshots, plan review gate and the YOLO master switch. */
import type { StateCreator } from 'zustand'
import { errorMessage } from '../useAppStore'
import type { AppState, OrchestratorSlice } from './types'

export const createOrchestratorSlice: StateCreator<AppState, [], [], OrchestratorSlice> = (
  set,
  get
) => ({
  orchestrator: { goal: null, tasks: [] },
  orchestrators: {},
  yoloMaster: false,

  toggleYolo() {
    const next = !get().yoloMaster
    set({ yoloMaster: next })
    void window.vertragus.setConfig('yoloMaster', next)
    // Laufende Sessions binden ihr Profil beim Start; ohne Laufzeit-Propagation
    // erreicht der Master-Toggle nur neu gespawnte Teams (Retro Lauf 3).
    void window.vertragus.orchestrator.setYoloMaster(next).catch(() => undefined)
  },

  async reviewPendingPlan(approved) {
    const state = get()
    const workspaceSessionId = state.activeWorkspaceSessionId ?? undefined
    try {
      const resolved = await window.vertragus.orchestrator.reviewPlan(
        state.activeProfileId,
        approved,
        workspaceSessionId
      )
      if (!resolved) {
        state.showToast('Kein Plan wartet mehr auf Freigabe.')
        return
      }
      const snapshot = await window.vertragus.orchestrator.snapshot(
        state.activeProfileId,
        workspaceSessionId
      )
      set((current) => ({
        orchestrator: snapshot,
        orchestrators: {
          ...current.orchestrators,
          [snapshot.workspaceSessionId ?? state.activeProfileId]: snapshot
        }
      }))
      get().showToast(approved ? 'Plan freigegeben.' : 'Plan abgelehnt.')
    } catch (error) {
      state.showToast(`Planfreigabe fehlgeschlagen: ${errorMessage(error)}`)
    }
  }
})
