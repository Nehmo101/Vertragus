/**
 * Draft state for the profile editor as a pure reducer.
 *
 * One action per field group/section keeps every update path explicit and —
 * because `dispatch` is referentially stable — lets the section components be
 * wrapped in React.memo: typing in one section never re-renders the others.
 * Semantics mirror the previous setDraft closures one to one.
 */
import type {
  AgentSlot,
  AutoGitConfig,
  AutoPrConfig,
  OrchestratorConfig,
  PlannerConfig,
  ProfileSkill,
  WorkspaceProfile
} from '@shared/profile'
import { slotWithMultiAgentOverride, type MultiAgentOverrideChoice } from './MultiAgentOverrideSelect'

export type ProfileEditorMode = 'orchestrated' | 'single' | 'solo'

export type ProfileDraftAction =
  | { type: 'patchProfile'; patch: Partial<WorkspaceProfile> }
  | { type: 'patchOrchestrator'; patch: Partial<OrchestratorConfig> }
  | { type: 'setMode'; mode: ProfileEditorMode }
  | { type: 'patchPlanner'; patch: Partial<PlannerConfig> }
  | { type: 'setBenchmarkEnabled'; enabled: boolean }
  | { type: 'setMultiAgentEnabled'; enabled: boolean }
  | { type: 'patchAutoPr'; patch: Partial<AutoPrConfig> }
  | { type: 'patchAutoGit'; patch: Partial<AutoGitConfig> }
  | { type: 'addSkill' }
  | { type: 'patchSkill'; index: number; patch: Partial<ProfileSkill> }
  | { type: 'removeSkill'; index: number }
  | { type: 'addSlot' }
  | { type: 'patchSlot'; index: number; patch: Partial<AgentSlot> }
  | { type: 'setSlotMultiAgent'; index: number; choice: MultiAgentOverrideChoice }
  | { type: 'removeSlot'; index: number }
  | { type: 'replaceAgents'; agents: AgentSlot[] }
  | { type: 'applyGeneratedProfile'; generated: WorkspaceProfile }

export function profileDraftReducer(
  state: WorkspaceProfile | null,
  action: ProfileDraftAction
): WorkspaceProfile | null {
  if (!state) return state

  switch (action.type) {
    case 'patchProfile':
      return { ...state, ...action.patch }
    case 'patchOrchestrator':
      if (!state.orchestrator) return state
      return { ...state, orchestrator: { ...state.orchestrator, ...action.patch } }
    case 'setMode': {
      if (action.mode === 'orchestrated') {
        if (state.orchestrator) return state
        return {
          ...state,
          solo: false,
          orchestrator: {
            provider: 'claude',
            // The preset defines the default; a model remains an
            // intentional, provider-specific override.
            model: '',
            modelPreset: 'balanced',
            permissionMode: 'default',
            autoOpenSubwindows: true
          }
        }
      }
      if (action.mode === 'single') {
        return { ...state, orchestrator: undefined, solo: false }
      }
      // Solo requires exactly one slot with count 1 (schema constraint).
      const first: AgentSlot = state.agents[0] ?? {
        role: 'solo',
        provider: 'claude',
        model: '',
        modelPreset: 'balanced',
        count: 1,
        orchestrated: false,
        yolo: false,
        strengths: [],
        weaknesses: []
      }
      return {
        ...state,
        orchestrator: undefined,
        solo: true,
        agents: [{ ...first, count: 1, orchestrated: false }],
        planner: { ...state.planner, mode: 'manual', maxParallel: 1, maxRetries: 0 },
        benchmark: { enabled: false },
        multiAgent: { ...state.multiAgent, enabled: false }
      }
    }
    case 'patchPlanner':
      return { ...state, planner: { ...state.planner, ...action.patch } }
    case 'setBenchmarkEnabled':
      return { ...state, benchmark: { enabled: action.enabled } }
    case 'setMultiAgentEnabled':
      return { ...state, multiAgent: { ...state.multiAgent, enabled: action.enabled } }
    case 'patchAutoPr':
      return { ...state, autoPr: { ...state.autoPr, ...action.patch } }
    case 'patchAutoGit':
      return { ...state, autoGit: { ...state.autoGit, ...action.patch } }
    case 'addSkill': {
      const skill: ProfileSkill = {
        id: `skill-${Date.now().toString(36)}`,
        name: '',
        instructions: '',
        source: 'user',
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
      return { ...state, skills: [...(state.skills ?? []), skill] }
    }
    case 'patchSkill': {
      const skills = (state.skills ?? []).map((skill, i) =>
        i === action.index ? { ...skill, ...action.patch, updatedAt: Date.now() } : skill
      )
      return { ...state, skills }
    }
    case 'removeSkill':
      return { ...state, skills: (state.skills ?? []).filter((_, i) => i !== action.index) }
    case 'addSlot':
      return {
        ...state,
        agents: [
          ...state.agents,
          {
            role: 'worker',
            provider: 'codex',
            model: '',
            modelPreset: 'balanced',
            count: 1,
            orchestrated: true,
            yolo: false,
            strengths: [],
            weaknesses: []
          }
        ]
      }
    case 'patchSlot':
      return {
        ...state,
        agents: state.agents.map((slot, i) =>
          i === action.index ? { ...slot, ...action.patch } : slot
        )
      }
    case 'setSlotMultiAgent':
      return {
        ...state,
        agents: state.agents.map((slot, i) =>
          i === action.index ? slotWithMultiAgentOverride(slot, action.choice) : slot
        )
      }
    case 'removeSlot':
      return { ...state, agents: state.agents.filter((_, i) => i !== action.index) }
    case 'replaceAgents':
      return { ...state, agents: action.agents }
    case 'applyGeneratedProfile':
      // Keep the bindings the generator must not touch (repo/project/auto-git).
      return {
        ...action.generated,
        githubRepo: state.githubRepo,
        githubProject: state.githubProject,
        autoGit: state.autoGit
      }
  }
}
