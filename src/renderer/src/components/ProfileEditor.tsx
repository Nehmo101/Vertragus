import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { profileHasRunningAgents, useAppStore } from '@renderer/store/useAppStore'
import {
  profileRepoLocalPath,
  type AgentSlot,
  type AutoGitConfig,
  type AutoPrConfig,
  type OrchestratorConfig,
  type PlannerConfig,
  type ProfileSkill,
  type WorkspaceProfile
} from '@shared/profile'
import { postProcessBranchValidationError } from '@shared/gitPostProcessing'
import { resolveModel } from '@shared/models'
import InfoTip from '@renderer/components/InfoTip'
import { HELP } from './profileEditor/help'
import { selectionHasUnavailablePreset } from './profileEditor/modelSelection'
import {
  profileDraftReducer,
  type ProfileEditorMode
} from './profileEditor/draftReducer'
import type { MultiAgentOverrideChoice } from './profileEditor/MultiAgentOverrideSelect'
import GithubAuthSection from './profileEditor/GithubAuthSection'
import RepoWorkspaceSection from './profileEditor/RepoWorkspaceSection'
import ModeOrchestratorSection from './profileEditor/ModeOrchestratorSection'
import PlannerSection from './profileEditor/PlannerSection'
import AutoPrSection from './profileEditor/AutoPrSection'
import AutoGitSection from './profileEditor/AutoGitSection'
import SkillsSection from './profileEditor/SkillsSection'
import AgentSlotsSection from './profileEditor/AgentSlotsSection'

// The multi-agent override helpers moved to profileEditor/; re-exported here so
// the module's public surface stays unchanged for existing importers.
export {
  MultiAgentOverrideSelect,
  effectiveMultiAgentEnabled,
  multiAgentOverrideChoice,
  slotWithMultiAgentOverride
} from './profileEditor/MultiAgentOverrideSelect'
export type { MultiAgentOverrideChoice } from './profileEditor/MultiAgentOverrideSelect'

export default function ProfileEditor(): JSX.Element | null {
  // Pick exactly the fields/actions the editor reads (actions are stable in
  // zustand); a bare useAppStore() would re-render the whole modal on every
  // orchestrator/event tick.
  const store = useAppStore(
    useShallow((s) => ({
      editorProfile: s.editorProfile,
      profiles: s.profiles,
      agents: s.agents,
      models: s.models,
      disabledModels: s.disabledModels,
      providerEnabled: s.providerEnabled,
      githubAuth: s.githubAuth,
      githubAuthBusy: s.githubAuthBusy,
      closeEditor: s.closeEditor,
      saveEditor: s.saveEditor,
      deleteProfile: s.deleteProfile,
      duplicateProfile: s.duplicateProfile,
      refreshGithubAuth: s.refreshGithubAuth,
      githubLogin: s.githubLogin,
      githubLogout: s.githubLogout,
      githubTerminalLogin: s.githubTerminalLogin
    }))
  )
  const initial = store.editorProfile
  const [draft, dispatch] = useReducer(profileDraftReducer, initial)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [generatingProfile, setGeneratingProfile] = useState(false)
  const [generateStatus, setGenerateStatus] = useState('')
  const [generateElapsed, setGenerateElapsed] = useState(0)
  const [learningsStatus, setLearningsStatus] = useState('')
  const nameRef = useRef<HTMLInputElement>(null)
  const closeEditorRef = useRef(store.closeEditor)
  const refreshGithubAuthRef = useRef(store.refreshGithubAuth)
  // Latest draft for async handlers (generate/apply-learnings) without making
  // their callbacks unstable — the memoized sections keep referential props.
  const draftRef = useRef(draft)
  useEffect(() => {
    draftRef.current = draft
  })

  useEffect(() => {
    const closeEditor = closeEditorRef.current
    nameRef.current?.focus({ preventScroll: true })
    void refreshGithubAuthRef.current()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeEditor()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // Live elapsed counter so the long-running repo analysis never looks frozen.
  // The counter is reset to 0 when generation starts (see generateFromRepo).
  useEffect(() => {
    if (!generatingProfile) return
    const startedAt = Date.now()
    const timer = setInterval(() => {
      setGenerateElapsed(Math.floor((Date.now() - startedAt) / 1000))
    }, 1000)
    return () => clearInterval(timer)
  }, [generatingProfile])

  // One stable callback per field group/section (dispatch never changes), so
  // every React.memo section only re-renders when its own draft slice changes.
  const actions = useMemo(
    () => ({
      patchProfile: (patch: Partial<WorkspaceProfile>) => dispatch({ type: 'patchProfile', patch }),
      patchOrchestrator: (patch: Partial<OrchestratorConfig>) =>
        dispatch({ type: 'patchOrchestrator', patch }),
      setMode: (mode: ProfileEditorMode) => dispatch({ type: 'setMode', mode }),
      patchPlanner: (patch: Partial<PlannerConfig>) => dispatch({ type: 'patchPlanner', patch }),
      setBenchmarkEnabled: (enabled: boolean) => dispatch({ type: 'setBenchmarkEnabled', enabled }),
      setMultiAgentEnabled: (enabled: boolean) =>
        dispatch({ type: 'setMultiAgentEnabled', enabled }),
      patchAutoPr: (patch: Partial<AutoPrConfig>) => dispatch({ type: 'patchAutoPr', patch }),
      patchAutoGit: (patch: Partial<AutoGitConfig>) => dispatch({ type: 'patchAutoGit', patch }),
      addSkill: () => dispatch({ type: 'addSkill' }),
      patchSkill: (index: number, patch: Partial<ProfileSkill>) =>
        dispatch({ type: 'patchSkill', index, patch }),
      removeSkill: (index: number) => dispatch({ type: 'removeSkill', index }),
      addSlot: () => dispatch({ type: 'addSlot' }),
      patchSlot: (index: number, patch: Partial<AgentSlot>) =>
        dispatch({ type: 'patchSlot', index, patch }),
      setSlotMultiAgent: (index: number, choice: MultiAgentOverrideChoice) =>
        dispatch({ type: 'setSlotMultiAgent', index, choice }),
      removeSlot: (index: number) => dispatch({ type: 'removeSlot', index })
    }),
    []
  )

  const generateFromRepo = useCallback(async (): Promise<void> => {
    const draft = draftRef.current
    if (!draft) return
    const analyzer = draft.orchestrator ?? draft.agents[0]
    const workingDir = profileRepoLocalPath(draft)
    if (!analyzer || !workingDir) {
      setGenerateStatus('Bitte zuerst ein Working Directory und ein Analysemodell auswählen.')
      return
    }
    setGenerateElapsed(0)
    setGeneratingProfile(true)
    setGenerateStatus('')
    try {
      const generated = await window.vertragus.generateProfileForRepo({
        workingDir,
        provider: analyzer.provider,
        model: analyzer.model,
        modelPreset: analyzer.modelPreset
      })
      dispatch({ type: 'applyGeneratedProfile', generated })
      setGenerateStatus('Repo-Profil erzeugt. Rollen und Quality Gates bitte prüfen.')
    } catch (error) {
      setGenerateStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setGeneratingProfile(false)
    }
  }, [])

  const applyLearnings = useCallback(async (): Promise<void> => {
    const draft = draftRef.current
    if (!draft) return
    try {
      const learnings = await window.vertragus.retro.listLearnings()
      if (learnings.length === 0) {
        setLearningsStatus('Noch keine gespeicherten Retro-/Benchmark-Erkenntnisse vorhanden.')
        return
      }
      let applied = 0
      const agents = draft.agents.map((slot) => {
        const model = resolveModel(slot.provider, slot).trim().toLowerCase()
        const matches = learnings.filter(
          (learning) =>
            learning.provider === slot.provider &&
            (model === '' || learning.model.trim().toLowerCase() === model)
        )
        if (matches.length === 0) return slot
        const merge = (current: string[], additions: string[]): string[] => {
          const seen = new Set(current.map((entry) => entry.toLowerCase()))
          const merged = [...current]
          for (const addition of additions) {
            if (seen.has(addition.toLowerCase()) || merged.length >= 24) continue
            seen.add(addition.toLowerCase())
            merged.push(addition)
            applied += 1
          }
          return merged
        }
        return {
          ...slot,
          strengths: merge(
            slot.strengths,
            matches.filter((learning) => learning.kind === 'strength').map((learning) => learning.insight)
          ),
          weaknesses: merge(
            slot.weaknesses,
            matches.filter((learning) => learning.kind === 'weakness').map((learning) => learning.insight)
          )
        }
      })
      dispatch({ type: 'replaceAgents', agents })
      setLearningsStatus(
        applied > 0
          ? `${applied} Erkenntnis(se) in Stärken/Schwächen übernommen. Bitte prüfen und speichern.`
          : 'Keine neuen Erkenntnisse für die konfigurierten Provider/Modelle gefunden.'
      )
    } catch (error) {
      setLearningsStatus(error instanceof Error ? error.message : String(error))
    }
  }, [])

  if (!initial || !draft) return null

  const githubTerminalLoginRunning = store.agents.some(
    (agent) => agent.taskId === 'auth:github' && agent.status === 'running'
  )

  const subTotal = draft.agents.reduce((n, s) => n + s.count, 0)
  const hasOrch = Boolean(draft.orchestrator)
  const grandTotal = subTotal + (hasOrch ? 1 : 0)
  const isSavedProfile = store.profiles.some((profile) => profile.id === draft.id)
  const hasRunningAgents = profileHasRunningAgents(store.agents, draft.id)
  const autoGitBranchError = postProcessBranchValidationError(
    draft.autoGit.targetBranch,
    draft.autoGit.enabled
  )
  const unavailablePresetCount =
    (draft.orchestrator &&
    selectionHasUnavailablePreset(
      store.models,
      draft.orchestrator.provider,
      draft.orchestrator.model,
      draft.orchestrator.modelPreset
    )
      ? 1
      : 0) +
    draft.agents.filter((slot) =>
      selectionHasUnavailablePreset(store.models, slot.provider, slot.model, slot.modelPreset)
    ).length

  return (
    <div className="modal-wrap">
      <div className="modal-scrim" onClick={store.closeEditor} />
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="profile-editor-title">
        <div className="modal-head">
          <span className="modal-gear">⚙</span>
          <div style={{ flex: 1 }}>
            <div className="modal-title" id="profile-editor-title">Profil-Editor</div>
            <div className="modal-sub">Orchestrator &amp; Subagent-Slots konfigurieren</div>
          </div>
          <button type="button" className="modal-close" aria-label="Profil-Editor schließen" onClick={store.closeEditor}>
            ✕
          </button>
        </div>

        <div className="modal-body">
          <label className="field-label" htmlFor="profile-name">
            Profilname <InfoTip text={HELP.profileName} />
          </label>
          <input
            ref={nameRef}
            id="profile-name"
            className="text-input"
            value={draft.name}
            onChange={(e) => actions.patchProfile({ name: e.target.value })}
          />

          <GithubAuthSection
            githubAuth={store.githubAuth}
            githubAuthBusy={store.githubAuthBusy}
            terminalLoginRunning={githubTerminalLoginRunning}
            onLogin={store.githubLogin}
            onLogout={store.githubLogout}
            onTerminalLogin={store.githubTerminalLogin}
          />

          <RepoWorkspaceSection
            workingDir={draft.workingDir}
            repoLocalPath={profileRepoLocalPath(draft)}
            generating={generatingProfile}
            generateElapsed={generateElapsed}
            generateStatus={generateStatus}
            learningsStatus={learningsStatus}
            onPatchProfile={actions.patchProfile}
            onGenerateFromRepo={generateFromRepo}
            onApplyLearnings={applyLearnings}
          />

          <ModeOrchestratorSection
            orchestrator={draft.orchestrator}
            solo={draft.solo}
            soloProvider={draft.agents[0]?.provider}
            providerEnabled={store.providerEnabled}
            models={store.models}
            disabledModels={store.disabledModels}
            onSetMode={actions.setMode}
            onPatchOrchestrator={actions.patchOrchestrator}
          />

          <PlannerSection
            planner={draft.planner}
            benchmarkEnabled={draft.benchmark.enabled}
            multiAgentEnabled={draft.multiAgent.enabled}
            hasOrchestrator={hasOrch}
            onPatchPlanner={actions.patchPlanner}
            onSetBenchmarkEnabled={actions.setBenchmarkEnabled}
            onSetMultiAgentEnabled={actions.setMultiAgentEnabled}
          />

          <AutoPrSection
            autoPr={draft.autoPr}
            boundDefaultBranch={draft.githubRepo?.defaultBranch}
            onPatchAutoPr={actions.patchAutoPr}
          />

          <AutoGitSection
            autoGit={draft.autoGit}
            branchError={autoGitBranchError}
            onPatchAutoGit={actions.patchAutoGit}
          />

          <SkillsSection
            skills={draft.skills}
            onPatchSkill={actions.patchSkill}
            onAddSkill={actions.addSkill}
            onRemoveSkill={actions.removeSkill}
          />

          <AgentSlotsSection
            agents={draft.agents}
            workspaceWorkingDir={draft.workingDir}
            multiAgentGlobalEnabled={draft.multiAgent.enabled}
            providerEnabled={store.providerEnabled}
            models={store.models}
            disabledModels={store.disabledModels}
            onPatchSlot={actions.patchSlot}
            onSetSlotMultiAgent={actions.setSlotMultiAgent}
            onRemoveSlot={actions.removeSlot}
            onAddSlot={actions.addSlot}
          />
        </div>

        {confirmDelete && (
          <div className="profile-delete-confirm" role="alertdialog" aria-modal="true" aria-labelledby="profile-delete-title">
            <div className="profile-delete-head">
              <span aria-hidden="true">⚠</span>
              <b id="profile-delete-title">Profil löschen?</b>
            </div>
            <div className="profile-delete-text">
              „{draft.name}" und alle zugehörigen Einstellungen werden dauerhaft entfernt.
              {store.profiles.length === 1 && ' Danach wird das Standardprofil wiederhergestellt.'}
            </div>
            <div className="profile-delete-actions">
              <button type="button" className="btn-ghost" onClick={() => setConfirmDelete(false)}>
                Abbrechen
              </button>
              <button type="button" className="btn-danger" onClick={() => void store.deleteProfile(draft.id)}>
                Endgültig löschen
              </button>
            </div>
          </div>
        )}
        <div className="modal-foot">
          <div className="totals">
            Gesamt: <b>{hasOrch ? 1 : 0}</b> Orchestrator + <b>{subTotal}</b> Subagents ={' '}
            <b className="grand">{grandTotal} Agents</b>
          </div>
          {isSavedProfile && (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void store.duplicateProfile(draft.id)}
            >
              Profil duplizieren
            </button>
          )}
          {isSavedProfile && (
            <button
              type="button"
              className="btn-danger modal-delete-btn"
              disabled={hasRunningAgents}
              title={hasRunningAgents ? 'Während einer laufenden Agent-Session nicht verfügbar' : 'Profil löschen'}
              onClick={() => setConfirmDelete(true)}
            >
              Profil löschen
            </button>
          )}
          {unavailablePresetCount > 0 && (
            <div className="model-preset-warning" role="alert">
              {unavailablePresetCount} Preset(s) sind für den Live-Katalog nicht verfügbar. Wähle
              CLI-Standard oder ein explizites Modell.
            </div>
          )}
          {autoGitBranchError && (
            <div className="model-preset-warning" role="alert">
              Auto-Commit &amp; Push: Ziel-Branch korrigieren.
            </div>
          )}
          <button type="button" className="btn-secondary" onClick={store.closeEditor}>
            Abbrechen
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={unavailablePresetCount > 0 || Boolean(autoGitBranchError)}
            title={
              unavailablePresetCount > 0
                ? 'Nicht verfügbare Modell-Presets zuerst korrigieren'
                : autoGitBranchError
                  ? autoGitBranchError
                : undefined
            }
            onClick={() => void store.saveEditor(draft)}
          >
            Profil speichern
          </button>
        </div>
      </div>
    </div>
  )
}
