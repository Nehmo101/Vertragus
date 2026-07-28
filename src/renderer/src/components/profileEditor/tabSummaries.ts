/**
 * Pure per-tab summary lines for the profile editor tab bar.
 *
 * Each function derives a compact one-liner from the draft alone, so the tab
 * bar can show what a hidden panel contains without rendering it. Pure
 * functions over WorkspaceProfile — unit-tested in tabSummaries.test.ts.
 * The translator is injected so the functions stay free of React/i18n state.
 */
import type { ModelPreset } from '@shared/models'
import type { AgentProviderId } from '@shared/providers'
import type { WorkspaceProfile } from '@shared/profile'

export type ProfileEditorTabId = 'repo' | 'mode' | 'slots' | 'automation' | 'skills'

/** Minimal translate signature so i18next's `t` can be passed straight through. */
export type SummaryTranslate = (key: string, options?: Record<string, unknown>) => string

/** "provider/modell" — explizites Modell vor Preset, sonst CLI-Standard. */
function modelLabel(
  t: SummaryTranslate,
  provider: AgentProviderId,
  model: string,
  preset?: ModelPreset
): string {
  const explicit = model.trim()
  if (explicit) return `${provider}/${explicit}`
  if (preset) return `${provider}/${preset}`
  return `${provider}/${t('profile.cliDefault')}`
}

/** Repo-Tab: GitHub-Bindung vor lokalem Working-Directory-Namen. */
export function repoTabSummary(draft: WorkspaceProfile, t: SummaryTranslate): string {
  if (draft.githubRepo) return `${draft.githubRepo.owner}/${draft.githubRepo.repo}`
  const dir = draft.workingDir.trim()
  if (!dir) return t('profile.summary.noRepo')
  const base = dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop()
  return base || dir
}

/** Modus-Tab: aktiver Modus plus dem Modell, das ihn treibt. */
export function modeTabSummary(draft: WorkspaceProfile, t: SummaryTranslate): string {
  if (draft.orchestrator) {
    const { provider, model, modelPreset } = draft.orchestrator
    return t('profile.summary.orchestrated', {
      model: modelLabel(t, provider, model, modelPreset)
    })
  }
  if (draft.solo) {
    const first = draft.agents[0]
    if (!first) return t('profile.summary.solo')
    return t('profile.summary.soloModel', {
      model: modelLabel(t, first.provider, first.model, first.modelPreset)
    })
  }
  const slots = draft.agents.length
  return slots === 1
    ? t('profile.summary.singleOne')
    : t('profile.summary.singleMany', { n: slots })
}

/** Slots-Tab: Slot-Zeilen, Provider-Vielfalt und (falls abweichend) Instanzen. */
export function slotsTabSummary(draft: WorkspaceProfile, t: SummaryTranslate): string {
  const slots = draft.agents
  if (slots.length === 0) return t('profile.summary.noSlots')
  const providers = new Set(slots.map((slot) => slot.provider)).size
  const instances = slots.reduce((sum, slot) => sum + slot.count, 0)
  const base =
    slots.length === 1
      ? t('profile.summary.slotBaseOne', { providers })
      : t('profile.summary.slotBaseMany', { n: slots.length, providers })
  return instances > slots.length
    ? `${base}${t('profile.summary.agentsSuffix', { n: instances })}`
    : base
}

/** Auto-PR-&-Git-Tab: PR-Modus/Strategie plus Auto-Git-Zielbranch. */
export function automationTabSummary(draft: WorkspaceProfile, t: SummaryTranslate): string {
  const pr =
    draft.autoPr.mode === 'off'
      ? t('profile.summary.autoPrOff')
      : `${draft.autoPr.mode} · ${draft.autoPr.strategy}`
  const git = draft.autoGit.enabled
    ? t('profile.summary.pushTo', { branch: draft.autoGit.targetBranch.trim() || '?' })
    : t('profile.summary.autoGitOff')
  return `${pr} · ${git}`
}

/** Skills-Tab: nur die Anzahl — Details stehen im Panel. */
export function skillsTabSummary(draft: WorkspaceProfile, t: SummaryTranslate): string {
  const count = (draft.skills ?? []).length
  if (count === 0) return t('profile.summary.noSkills')
  return count === 1 ? t('profile.summary.skillOne') : t('profile.summary.skillMany', { n: count })
}

/** Alle Zusammenfassungen auf einmal — eine Zeile je Tab. */
export function tabSummaries(
  draft: WorkspaceProfile,
  t: SummaryTranslate
): Record<ProfileEditorTabId, string> {
  return {
    repo: repoTabSummary(draft, t),
    mode: modeTabSummary(draft, t),
    slots: slotsTabSummary(draft, t),
    automation: automationTabSummary(draft, t),
    skills: skillsTabSummary(draft, t)
  }
}
