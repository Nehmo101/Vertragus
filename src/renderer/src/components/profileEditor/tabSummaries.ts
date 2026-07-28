/**
 * Pure per-tab summary lines for the profile editor tab bar.
 *
 * Each function derives a compact one-liner from the draft alone, so the tab
 * bar can show what a hidden panel contains without rendering it. Pure
 * functions over WorkspaceProfile — unit-tested in tabSummaries.test.ts.
 */
import type { ModelPreset } from '@shared/models'
import type { AgentProviderId } from '@shared/providers'
import type { WorkspaceProfile } from '@shared/profile'

export type ProfileEditorTabId = 'repo' | 'mode' | 'slots' | 'automation' | 'skills'

/** "provider/modell" — explizites Modell vor Preset, sonst CLI-Standard. */
function modelLabel(provider: AgentProviderId, model: string, preset?: ModelPreset): string {
  const explicit = model.trim()
  if (explicit) return `${provider}/${explicit}`
  if (preset) return `${provider}/${preset}`
  return `${provider}/CLI-Standard`
}

/** Repo-Tab: GitHub-Bindung vor lokalem Working-Directory-Namen. */
export function repoTabSummary(draft: WorkspaceProfile): string {
  if (draft.githubRepo) return `${draft.githubRepo.owner}/${draft.githubRepo.repo}`
  const dir = draft.workingDir.trim()
  if (!dir) return 'Kein Repo verbunden'
  const base = dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop()
  return base || dir
}

/** Modus-Tab: aktiver Modus plus dem Modell, das ihn treibt. */
export function modeTabSummary(draft: WorkspaceProfile): string {
  if (draft.orchestrator) {
    const { provider, model, modelPreset } = draft.orchestrator
    return `Orchestriert · ${modelLabel(provider, model, modelPreset)}`
  }
  if (draft.solo) {
    const first = draft.agents[0]
    if (!first) return 'Efficiency Solo'
    return `Efficiency Solo · ${modelLabel(first.provider, first.model, first.modelPreset)}`
  }
  const slots = draft.agents.length
  return `Single · ${slots} Slot${slots === 1 ? '' : 's'} parallel`
}

/** Slots-Tab: Slot-Zeilen, Provider-Vielfalt und (falls abweichend) Instanzen. */
export function slotsTabSummary(draft: WorkspaceProfile): string {
  const slots = draft.agents
  if (slots.length === 0) return 'Keine Slots'
  const providers = new Set(slots.map((slot) => slot.provider)).size
  const instances = slots.reduce((sum, slot) => sum + slot.count, 0)
  const base = `${slots.length} Slot${slots.length === 1 ? '' : 's'} · ${providers} Provider`
  return instances > slots.length ? `${base} · ${instances} Agents` : base
}

/** Auto-PR-&-Git-Tab: PR-Modus/Strategie plus Auto-Git-Zielbranch. */
export function automationTabSummary(draft: WorkspaceProfile): string {
  const pr =
    draft.autoPr.mode === 'off'
      ? 'Auto-PR aus'
      : `${draft.autoPr.mode} · ${draft.autoPr.strategy}`
  const git = draft.autoGit.enabled
    ? `Push auf ${draft.autoGit.targetBranch.trim() || '?'}`
    : 'Auto-Git aus'
  return `${pr} · ${git}`
}

/** Skills-Tab: nur die Anzahl — Details stehen im Panel. */
export function skillsTabSummary(draft: WorkspaceProfile): string {
  const count = (draft.skills ?? []).length
  if (count === 0) return 'Keine Skills'
  return `${count} Skill${count === 1 ? '' : 's'}`
}

/** Alle Zusammenfassungen auf einmal — eine Zeile je Tab. */
export function tabSummaries(draft: WorkspaceProfile): Record<ProfileEditorTabId, string> {
  return {
    repo: repoTabSummary(draft),
    mode: modeTabSummary(draft),
    slots: slotsTabSummary(draft),
    automation: automationTabSummary(draft),
    skills: skillsTabSummary(draft)
  }
}
