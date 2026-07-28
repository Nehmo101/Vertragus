import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
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
import ProfileEditorTabs, {
  profileEditorPanelDomId,
  profileEditorTabDomId,
  type ProfileEditorTab
} from './profileEditor/ProfileEditorTabs'
import { tabSummaries, type ProfileEditorTabId } from './profileEditor/tabSummaries'
import tabStyles from './profileEditor/ProfileEditorTabs.module.css'

// The multi-agent override helpers moved to profileEditor/; re-exported here so
// the module's public surface stays unchanged for existing importers.
export {
  MultiAgentOverrideSelect,
  effectiveMultiAgentEnabled,
  multiAgentOverrideChoice,
  slotWithMultiAgentOverride
} from './profileEditor/MultiAgentOverrideSelect'
export type { MultiAgentOverrideChoice } from './profileEditor/MultiAgentOverrideSelect'

/**
 * Last active tab, remembered per app session (module variable, deliberately
 * not persisted): closing and reopening the editor lands in the same section.
 */
let lastActiveTab: ProfileEditorTabId = 'repo'

export default function ProfileEditor(): JSX.Element | null {
  const { t } = useTranslation()
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
  const [activeTab, setActiveTab] = useState<ProfileEditorTabId>(lastActiveTab)
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
      setGenerateStatus(t('profile.editor.generateNeedsDir'))
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
      setGenerateStatus(t('profile.editor.generateDone'))
    } catch (error) {
      setGenerateStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setGeneratingProfile(false)
    }
  }, [t])

  const selectTab = useCallback((id: ProfileEditorTabId): void => {
    lastActiveTab = id
    setActiveTab(id)
  }, [])

  const applyLearnings = useCallback(async (): Promise<void> => {
    const draft = draftRef.current
    if (!draft) return
    try {
      const learnings = await window.vertragus.retro.listLearnings()
      if (learnings.length === 0) {
        setLearningsStatus(t('profile.editor.learningsNone'))
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
          ? t('profile.editor.learningsApplied', { n: applied })
          : t('profile.editor.learningsNoMatch')
      )
    } catch (error) {
      setLearningsStatus(error instanceof Error ? error.message : String(error))
    }
  }, [t])

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
  // Preset issues split per tab (mode vs. slots) so the respective tab can
  // carry a warn badge; the sum still drives the footer.
  const orchestratorPresetUnavailable = Boolean(
    draft.orchestrator &&
      selectionHasUnavailablePreset(
        store.models,
        draft.orchestrator.provider,
        draft.orchestrator.model,
        draft.orchestrator.modelPreset
      )
  )
  const slotPresetCount = draft.agents.filter((slot) =>
    selectionHasUnavailablePreset(store.models, slot.provider, slot.model, slot.modelPreset)
  ).length
  const unavailablePresetCount = (orchestratorPresetUnavailable ? 1 : 0) + slotPresetCount

  // One summary line per tab plus warn badges for errors that would otherwise
  // stay undetected in a currently inactive tab.
  const summaries = tabSummaries(draft, t)
  const tabs: ProfileEditorTab[] = [
    { id: 'repo', label: t('profile.editor.tabRepo'), summary: summaries.repo },
    {
      id: 'mode',
      label: t('profile.editor.tabMode'),
      summary: summaries.mode,
      badge: orchestratorPresetUnavailable
        ? t('profile.editor.badgeOrchPreset')
        : undefined
    },
    {
      id: 'slots',
      label: t('profile.editor.tabSlots'),
      summary: summaries.slots,
      badge: slotPresetCount > 0 ? t('profile.editor.badgeSlotPresets', { n: slotPresetCount }) : undefined
    },
    {
      id: 'automation',
      label: t('profile.editor.tabAutomation'),
      summary: summaries.automation,
      badge: autoGitBranchError ? t('profile.editor.badgeBranch') : undefined
    },
    { id: 'skills', label: t('profile.editor.tabSkills'), summary: summaries.skills }
  ]

  return (
    <div className="modal-wrap">
      <div className="modal-scrim" onClick={store.closeEditor} />
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="profile-editor-title">
        <div className="modal-head">
          <span className="modal-gear">⚙</span>
          <div style={{ flex: 1 }}>
            <div className="modal-title" id="profile-editor-title">{t('profile.editor.title')}</div>
            <div className="modal-sub">{t('profile.editor.sub')}</div>
          </div>
          <button type="button" className="modal-close" aria-label={t('profile.editor.closeAria')} onClick={store.closeEditor}>
            ✕
          </button>
        </div>

        {/* Always visible, independent of the active tab: profile name + tab bar. */}
        <div className={tabStyles.head}>
          <label className="field-label" htmlFor="profile-name">
            {t('profile.editor.nameLabel')} <InfoTip text={t(HELP.profileName)} />
          </label>
          <input
            ref={nameRef}
            id="profile-name"
            className="text-input"
            value={draft.name}
            onChange={(e) => actions.patchProfile({ name: e.target.value })}
          />
          <ProfileEditorTabs tabs={tabs} activeTab={activeTab} onSelect={selectTab} />
        </div>

        <div className="modal-body">
          {/*
           * Only the active panel is mounted: the sections are props-driven via
           * the draft (the only local section state, the SoloModelHint, reloads
           * itself on remount), so no state is lost — and inactive tabs cost
           * no renders.
           */}
          <div
            role="tabpanel"
            id={profileEditorPanelDomId(activeTab)}
            aria-labelledby={profileEditorTabDomId(activeTab)}
          >
            {activeTab === 'repo' && (
              <>
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
              </>
            )}

            {activeTab === 'mode' && (
              <>
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
              </>
            )}

            {activeTab === 'slots' && (
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
            )}

            {activeTab === 'automation' && (
              <>
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
              </>
            )}

            {activeTab === 'skills' && (
              <SkillsSection
                skills={draft.skills}
                onPatchSkill={actions.patchSkill}
                onAddSkill={actions.addSkill}
                onRemoveSkill={actions.removeSkill}
              />
            )}
          </div>
        </div>

        {confirmDelete && (
          <div className="profile-delete-confirm" role="alertdialog" aria-modal="true" aria-labelledby="profile-delete-title">
            <div className="profile-delete-head">
              <span aria-hidden="true">⚠</span>
              <b id="profile-delete-title">{t('profile.editor.deleteTitle')}</b>
            </div>
            <div className="profile-delete-text">
              {t('profile.editor.deleteText', { name: draft.name })}
              {store.profiles.length === 1 && t('profile.editor.deleteLastHint')}
            </div>
            <div className="profile-delete-actions">
              <button type="button" className="btn-ghost" onClick={() => setConfirmDelete(false)}>
                {t('profile.editor.cancel')}
              </button>
              <button type="button" className="btn-danger" onClick={() => void store.deleteProfile(draft.id)}>
                {t('profile.editor.deleteConfirm')}
              </button>
            </div>
          </div>
        )}
        <div className="modal-foot">
          <div className="totals">
            {t('profile.editor.totalsLabel')} <b>{hasOrch ? 1 : 0}</b> {t('profile.editor.totalsOrchestrator')} + <b>{subTotal}</b> {t('profile.editor.totalsSubagents')} ={' '}
            <b className="grand">{t('profile.editor.totalsAgents', { n: grandTotal })}</b>
          </div>
          {isSavedProfile && (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void store.duplicateProfile(draft.id)}
            >
              {t('profile.editor.duplicate')}
            </button>
          )}
          {isSavedProfile && (
            <button
              type="button"
              className="btn-danger modal-delete-btn"
              disabled={hasRunningAgents}
              title={hasRunningAgents ? t('profile.editor.deleteDisabledTitle') : t('profile.editor.deleteBtn')}
              onClick={() => setConfirmDelete(true)}
            >
              {t('profile.editor.deleteBtn')}
            </button>
          )}
          {unavailablePresetCount > 0 && (
            <div className="model-preset-warning" role="alert">
              {t('profile.editor.presetWarning', { n: unavailablePresetCount })}
            </div>
          )}
          {autoGitBranchError && (
            <div className="model-preset-warning" role="alert">
              {t('profile.editor.branchWarning')}
            </div>
          )}
          <button type="button" className="btn-secondary" onClick={store.closeEditor}>
            {t('profile.editor.cancel')}
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={unavailablePresetCount > 0 || Boolean(autoGitBranchError)}
            title={
              unavailablePresetCount > 0
                ? t('profile.editor.saveDisabledPresets')
                : autoGitBranchError
                  ? autoGitBranchError
                : undefined
            }
            onClick={() => void store.saveEditor(draft)}
          >
            {t('profile.editor.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
