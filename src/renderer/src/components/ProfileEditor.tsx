import { useEffect, useRef, useState } from 'react'
import { profileHasRunningAgents, useAppStore } from '@renderer/store/useAppStore'
import { profileRepoLocalPath, type WorkspaceProfile, type AgentSlot } from '@shared/profile'
import { postProcessBranchValidationError } from '@shared/gitPostProcessing'
import type { AgentProviderId } from '@shared/providers'
import type { ModelPreset } from '@shared/models'
import {
  MODEL_PRESETS,
  MODEL_PRESET_LABELS,
  formatModelLabel,
  modelAfterProviderChange,
  resolveModel
} from '@shared/models'
import { recommendSoloModel } from '@shared/retro/soloModel'
import { PROVIDER_THEME } from '@renderer/ui/theme'
import InfoTip from '@renderer/components/InfoTip'
import { assertValidGithubAuthStatus, githubAuthPresentation, hasUsableGithubAuth } from '@renderer/store/githubAuth'
import ModelCatalogStatus from '@renderer/components/ModelCatalogStatus'
import { modelPresetAvailability } from '@renderer/modelCatalog'
import ClaudePermissionModeSelect from '@renderer/components/ClaudePermissionModeSelect'
import ModelCombo from '@renderer/components/ModelCombo'

const AGENT_PROVIDERS: AgentProviderId[] = ['claude', 'kimi', 'codex', 'cursor', 'copilot', 'ollama']

const ORCHESTRATOR_PROVIDERS: AgentProviderId[] = ['claude', 'kimi', 'codex', 'copilot']
export type MultiAgentOverrideChoice = 'inherit' | 'on' | 'off'

export function multiAgentOverrideChoice(value: boolean | undefined): MultiAgentOverrideChoice {
  return value === undefined ? 'inherit' : value ? 'on' : 'off'
}

export function slotWithMultiAgentOverride(
  slot: AgentSlot,
  choice: MultiAgentOverrideChoice
): AgentSlot {
  const next = { ...slot }
  if (choice === 'inherit') {
    delete next.multiAgent
  } else {
    next.multiAgent = choice === 'on'
  }
  return next
}

export function effectiveMultiAgentEnabled(slot: AgentSlot, globalEnabled: boolean): boolean {
  return slot.multiAgent ?? globalEnabled
}

const HELP = {
  profileName: 'Frei wählbarer Name für diese Kombination aus Workspace, Orchestrator und Subagents.',
  workingDir: 'Lokaler Repository- oder Projektordner, in dem die Agents arbeiten. Der Auto-PR-Basisbranch wird bei Bedarf aus dem git-origin dieses Ordners abgeleitet.',
  githubAuth: 'Browser-OAuth (Device Flow mit VERTRAGUS_GITHUB_OAUTH_CLIENT_ID) oder gh --web. Tokens werden verschlüsselt lokal gespeichert, nie im Profil oder in Logs. Wird für Auto-PR benötigt.',
  generateFromRepo: 'Das gewählte Analysemodell liest das Working-Directory-Repository read-only und schlägt Rollen, Modelle und Quality Gates vor. Kann je nach Repo-Größe ein bis mehrere Minuten dauern.',
  agentWorkingDir: 'Optionaler Pfad nur für diesen Slot. Leer übernimmt den Workspace-Basispfad.',
  mode: 'Orchestriert lässt Claude oder Codex planen und delegieren. Single startet nur die konfigurierten Slots. Efficiency Solo startet genau EINEN Agenten, der direkt arbeitet — minimale Token-Fixkosten, Retro-Learnings im Prompt, nur report_activity/record_retro als Tools.',
  orchestratorProvider: 'Nur Provider mit verifiziertem Vertragus-MCP-Adapter können orchestrieren.',
  permissionMode: 'Auto-Mode bestätigt Edits automatisch. Plan-Mode erlaubt Claude nur zu planen.',
  model: 'Leer verwendet Preset oder CLI-Standard. Freitext überschreibt das Preset. Über das Listen-Menü rechts wählst du jederzeit ein anderes Modell — auch wenn schon eines eingetragen ist.',
  modelPreset: 'Leistungs-Preset (schnell/ausgewogen/stark). Gilt nur wenn Modell leer ist — Freitext hat Vorrang.',
  plannerMode: 'Auto startet valide Pläne direkt. Review wartet auf Freigabe. Manuell deaktiviert execute_plan.',
  routingMode: 'Adaptiv startet zunächst nur den Orchestrator und aktiviert Task-Agents passend zum Plan. Vorgewärmt startet alle Slots sofort.',
  maxParallel: 'Globales Oberlimit gleichzeitig laufender Plan-Tasks; Rollen-Kapazitäten können es weiter reduzieren.',
  maxRetries: 'Wie oft der Orchestrator nach einem fehlgeschlagenen Plan ohne neue Nutzerinformation fokussiert nachplanen darf.',
  multiAgent: 'Startet für jede delegierte Aufgabe alle Instanzen des gewählten Slots parallel. Ein Slot-Override hat Vorrang; „Global erben“ übernimmt diese globale Einstellung. Die Runtime bildet weiterhin nur bei orchestriertem Einsatz und Anzahl > 1 eine Kandidatengruppe, speichert den Override aber unabhängig davon.',
  autoPrMode: 'PRs entstehen nur nach erfolgreichen Gates. Draft ist der empfohlene sichere Startmodus.',
  prStrategy: 'Aggregate kombiniert Task-Commits in einen Goal-PR. Per Task erzeugt getrennte PRs.',
  baseBranch: 'Zielbranch des PRs. Leer nutzt den gebundenen Standardbranch oder den des origin-Remotes.',
  qualityGates: 'Vertrauenswürdige Shell-Befehle, die im Task- und Integrations-Worktree erfolgreich laufen müssen.',
  autoGitMode: 'Nach einem vollständig erfolgreichen Workspace-Lauf werden alle Änderungen im Workspace committet und zu origin gepusht. Bei Fehlern bleibt der Lauf rot.',
  autoGitBranch: 'Expliziter Ziel-Branch auf origin. Optionen, Ref-Specs, Revisionen, Leerzeichen und Steuerzeichen werden abgewiesen.',
  role: 'Eindeutige Fähigkeit, die der Planner adressiert, etwa frontend, backend, tests oder review.',
  agentProvider: 'CLI, die diesen Slot ausführt. Der Login erfolgt separat in der Provider-Seitenleiste.',
  count: 'Maximale parallele Task-Kapazität dieser Rolle und Anzahl beim manuellen Teamstart.',
  yolo: 'Überspringt Provider-Bestätigungen. Nur mit Worktree-Isolation und bewusstem Scope verwenden.',
  orchestrated: 'Wenn aktiv, darf der Orchestrator Aufgaben an diesen Slot delegieren.',
  strengths: 'Kommagetrennte Fähigkeiten, die der Orchestrator bei der Rollenwahl bevorzugen soll.',
  weaknesses: 'Kommagetrennte Aufgaben, für die der Orchestrator diesen Slot möglichst nicht wählen soll.',
  benchmark:
    'Auto-Benchmark: Der Orchestrator gibt allen Slots dieselbe Aufgabe, vergleicht die Ergebnisse, ' +
    'bewertet sie und speichert die Erkenntnisse als Modellwissen für künftige Läufe.',
  applyLearnings:
    'Übernimmt gespeicherte Retro- und Benchmark-Erkenntnisse passend zu Provider und Modell ' +
    'in die Stärken/Schwächen der Slots. Die Erkenntnisse entstehen automatisch nach jedem Lauf.'
} as const

/**
 * Benchmark/retro-driven model suggestion for the Efficiency-Solo mode.
 * Pure hint — the user always keeps the final model choice.
 */
function SoloModelHint({ provider }: { provider?: AgentProviderId }): JSX.Element | null {
  const [hint, setHint] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [learnings, benchmarks] = await Promise.all([
          window.vertragus.retro.listLearnings(),
          window.vertragus.retro.listBenchmarks()
        ])
        const [best] = recommendSoloModel(learnings, benchmarks, provider)
        if (!cancelled) {
          setHint(
            best
              ? `Empfohlen laut Benchmarks/Retros: ${best.provider}${best.model ? ` · ${best.model}` : ' (CLI-Standard)'} — ${best.rationale}`
              : null
          )
        }
      } catch {
        if (!cancelled) setHint(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [provider])
  if (!hint) return null
  return (
    <div className="model-effective" aria-live="polite" style={{ marginBottom: 8 }}>
      {hint}
    </div>
  )
}

interface MultiAgentOverrideSelectProps {
  id: string
  value: boolean | undefined
  globalEnabled: boolean
  onChange: (choice: MultiAgentOverrideChoice) => void
}

export function MultiAgentOverrideSelect({
  id,
  value,
  globalEnabled,
  onChange
}: MultiAgentOverrideSelectProps): JSX.Element {
  const statusId = `${id}-status`
  const effectiveEnabled = value ?? globalEnabled

  return (
    <div className="slot-path-row">
      <div className="slot-path-field">
        <label className="field-label slot-col-label" htmlFor={id}>
          Multiagent-Modus <InfoTip text={HELP.multiAgent} />
        </label>
        <select
          id={id}
          className="slot-select-sm"
          value={multiAgentOverrideChoice(value)}
          aria-describedby={statusId}
          onChange={(event) => onChange(event.currentTarget.value as MultiAgentOverrideChoice)}
        >
          <option value="inherit">
            Global erben — aktuell {globalEnabled ? 'Aktiv' : 'Aus'}
          </option>
          <option value="on">Aktiv</option>
          <option value="off">Aus</option>
        </select>
        <div className="model-effective" id={statusId} aria-live="polite">
          Effektiv: {effectiveEnabled ? 'Aktiv' : 'Aus'}
          {' · '}
          {value === undefined
            ? 'globale Einstellung geerbt'
            : `Slot-Override · global ${globalEnabled ? 'Aktiv' : 'Aus'}`}
        </div>
      </div>
    </div>
  )
}

function boundedNumber(value: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
}
function parseCapabilityList(value: string): string[] {
  return [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))]
}
/** "m:ss" elapsed label for the long-running repo analysis. */
function formatElapsed(seconds: number): string {
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

export default function ProfileEditor(): JSX.Element | null {
  const store = useAppStore()
  const initial = store.editorProfile
  const [draft, setDraft] = useState<WorkspaceProfile | null>(initial)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [generatingProfile, setGeneratingProfile] = useState(false)
  const [generateStatus, setGenerateStatus] = useState('')
  const [generateElapsed, setGenerateElapsed] = useState(0)
  const [learningsStatus, setLearningsStatus] = useState('')
  const nameRef = useRef<HTMLInputElement>(null)
  const closeEditorRef = useRef(store.closeEditor)
  const refreshGithubAuthRef = useRef(store.refreshGithubAuth)

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

  if (!initial || !draft) return null

  const models = store.models
  const catalogFor = (p: AgentProviderId) => models[p]
  const modelsFor = (p: AgentProviderId): string[] =>
    catalogFor(p).models.filter(
      (model) => !store.disabledModels[p].some(
        (disabled) => disabled.toLowerCase() === model.toLowerCase()
      )
    )
  const presetValue = (preset?: ModelPreset): string => preset ?? ''
  const parsePreset = (value: string): ModelPreset | undefined =>
    value === 'fast' || value === 'balanced' || value === 'strong' ? value : undefined
  const presetAvailable = (provider: AgentProviderId, preset: ModelPreset): boolean =>
    modelPresetAvailability(provider, preset, catalogFor(provider)).available
  const selectionHasUnavailablePreset = (
    provider: AgentProviderId,
    model: string,
    preset?: ModelPreset
  ): boolean => Boolean(!model.trim() && preset && !presetAvailable(provider, preset))
  const unavailablePresetCount =
    (draft.orchestrator &&
    selectionHasUnavailablePreset(
      draft.orchestrator.provider,
      draft.orchestrator.model,
      draft.orchestrator.modelPreset
    )
      ? 1
      : 0) +
    draft.agents.filter((slot) =>
      selectionHasUnavailablePreset(slot.provider, slot.model, slot.modelPreset)
    ).length

  const patch = (p: Partial<WorkspaceProfile>): void => setDraft({ ...draft, ...p })
  const patchSlot = (idx: number, p: Partial<AgentSlot>): void => {
    const agents = draft.agents.map((s, i) => (i === idx ? { ...s, ...p } : s))
    setDraft({ ...draft, agents })
  }
  const patchSlotMultiAgent = (idx: number, choice: MultiAgentOverrideChoice): void => {
    const agents = draft.agents.map((slot, i) =>
      i === idx ? slotWithMultiAgentOverride(slot, choice) : slot
    )
    setDraft({ ...draft, agents })
  }
  const generateFromRepo = async (): Promise<void> => {
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
      setDraft({
        ...generated,
        githubRepo: draft.githubRepo,
        githubProject: draft.githubProject,
        autoGit: draft.autoGit
      })
      setGenerateStatus('Repo-Profil erzeugt. Rollen und Quality Gates bitte prüfen.')
    } catch (error) {
      setGenerateStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setGeneratingProfile(false)
    }
  }
  const applyLearnings = async (): Promise<void> => {
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
      setDraft({ ...draft, agents })
      setLearningsStatus(
        applied > 0
          ? `${applied} Erkenntnis(se) in Stärken/Schwächen übernommen. Bitte prüfen und speichern.`
          : 'Keine neuen Erkenntnisse für die konfigurierten Provider/Modelle gefunden.'
      )
    } catch (error) {
      setLearningsStatus(error instanceof Error ? error.message : String(error))
    }
  }
  const githubAuth = store.githubAuth
  // The OAuth status crosses the IPC bridge from main; validate its shape before
  // any connect/login action trusts it. A malformed payload is rejected, not used.
  let githubAuthError = ''
  if (githubAuth) {
    try {
      assertValidGithubAuthStatus(githubAuth)
    } catch (error) {
      githubAuthError = error instanceof Error ? error.message : String(error)
    }
  }
  const githubAuthUsable = !githubAuthError && hasUsableGithubAuth(githubAuth)
  const githubAuthView = githubAuthPresentation(githubAuth)
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
            onChange={(e) => patch({ name: e.target.value })}
          />

          <section className="github-repo-field" aria-labelledby="github-auth-heading">
            <div className="field-label" id="github-auth-heading">
              GitHub-Verbindung <InfoTip text={HELP.githubAuth} />
            </div>
            <div className="github-auth-row">
              <div className="github-auth-status" aria-live="polite" title={githubAuthView.detail}>
                <span className={githubAuthUsable ? 'github-auth-ok' : 'github-auth-warn'}>●</span>
                {githubAuthView.detail}
                {githubAuthUsable && githubAuth.scopes.length > 0
                  ? ` · ${githubAuth.scopes.join(', ')}`
                  : ''}
              </div>
              {!githubAuthUsable && (
                <button
                  type="button"
                  className="btn-secondary browse-btn"
                  disabled={store.githubAuthBusy || githubTerminalLoginRunning || Boolean(githubAuthError)}
                  onClick={() => void store.githubLogin()}
                >
                  {githubAuthView.label === 'Erneuern' ? 'Erneuern' : 'Verbinden'}
                </button>
              )}
              {githubAuthUsable && (
                <button
                  type="button"
                  className="btn-secondary browse-btn"
                  disabled={store.githubAuthBusy || githubTerminalLoginRunning}
                  onClick={() => void store.githubLogout()}
                >
                  Abmelden
                </button>
              )}
              <button
                type="button"
                className="btn-secondary browse-btn"
                title="Fallback: gh auth login im Terminal"
                disabled={store.githubAuthBusy || githubTerminalLoginRunning}
                onClick={() => void store.githubTerminalLogin()}
              >
                PTY
              </button>
            </div>
            {githubAuthError && (
              <div className="automation-validation-error" role="alert">
                {githubAuthError}
              </div>
            )}
          </section>

          <label className="field-label" htmlFor="profile-working-dir">
            Working Directory (Repo) <InfoTip text={HELP.workingDir} />
          </label>
          <div className="dir-row">
            <input
              id="profile-working-dir"
              className="text-input mono"
              placeholder="C:\git\mein-repo"
              value={draft.workingDir}
              onChange={(e) => patch({ workingDir: e.target.value })}
            />
            <button type="button"
              className="btn-secondary browse-btn"
              onClick={async () => {
                const dir = await window.vertragus.pickFolder()
                if (dir) patch({ workingDir: dir })
              }}
            >
              Durchsuchen…
            </button>
          </div>
          <button
            type="button"
            className="btn-secondary profile-generate-btn"
            disabled={generatingProfile || !profileRepoLocalPath(draft)}
            title={HELP.generateFromRepo}
            onClick={() => void generateFromRepo()}
          >
            {generatingProfile
              ? `Repo wird analysiert… ${formatElapsed(generateElapsed)}`
              : 'KI-Profil aus Git-Repo erzeugen'}
          </button>
          <button
            type="button"
            className="btn-secondary profile-generate-btn"
            title={HELP.applyLearnings}
            onClick={() => void applyLearnings()}
          >
            Retro-Erkenntnisse übernehmen
          </button>
          {generatingProfile && (
            <div className="profile-generate-progress" aria-live="polite">
              <span className="profile-generate-spinner" aria-hidden="true" />
              Das ausgewählte Modell liest das Repository read-only und entwirft ein Profil. Je
              nach Repo-Größe dauert das ein bis mehrere Minuten — das Fenster kann offen bleiben.
            </div>
          )}
          {(generateStatus || learningsStatus) && (
            <div className="github-project-status" aria-live="polite">
              {generateStatus || learningsStatus}
            </div>
          )}

          <div className="field-label" style={{ marginBottom: 8 }}>
            Modus <InfoTip text={HELP.mode} />
          </div>
          <div className="mode-toggle">
            <button type="button"
              className={draft.orchestrator ? 'active' : ''}
              onClick={() =>
                !draft.orchestrator &&
                patch({
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
                })
              }
            >
              🪄 Orchestriert
              <span>ein Orchestrator delegiert an Subagents</span>
            </button>
            <button type="button"
              className={!draft.orchestrator && !draft.solo ? 'active' : ''}
              onClick={() => patch({ orchestrator: undefined, solo: false })}
            >
              ⚡ Single
              <span>alle Slots laufen parallel, kein Orchestrator</span>
            </button>
            <button type="button"
              className={!draft.orchestrator && draft.solo ? 'active' : ''}
              onClick={() => {
                // Solo requires exactly one slot with count 1 (schema constraint).
                const first = draft.agents[0] ?? {
                  role: 'solo',
                  provider: 'claude' as AgentProviderId,
                  model: '',
                  modelPreset: 'balanced' as ModelPreset,
                  count: 1,
                  orchestrated: false,
                  yolo: false,
                  strengths: [],
                  weaknesses: []
                }
                setDraft({
                  ...draft,
                  orchestrator: undefined,
                  solo: true,
                  agents: [{ ...first, count: 1, orchestrated: false }],
                  planner: { ...draft.planner, mode: 'manual', maxParallel: 1, maxRetries: 0 },
                  benchmark: { enabled: false },
                  multiAgent: { ...draft.multiAgent, enabled: false }
                })
              }}
            >
              🎯 Efficiency Solo
              <span>ein Agent arbeitet direkt, minimaler Tokenverbrauch</span>
            </button>
          </div>
          {!draft.orchestrator && draft.solo && (
            <SoloModelHint provider={draft.agents[0]?.provider} />
          )}
          {draft.orchestrator ? (
            <div className="orch-block">
              <span className="avatar">◇</span>
              <div style={{ flex: 1 }}>
                <div className="select-label">
                  Provider <InfoTip text={HELP.orchestratorProvider} />
                </div>
                <select
                  className="select"
                  value={draft.orchestrator.provider}
                  onChange={(e) => {
                    const provider = e.target.value as AgentProviderId
                    patch({
                      orchestrator: {
                        ...draft.orchestrator!,
                        provider,
                        // An explicit model takes priority over a preset.
                        // Clear it only on a real provider switch so a stale,
                        // incompatible id never carries over — a same-provider
                        // reselect must keep the saved model.
                        model: modelAfterProviderChange(
                          draft.orchestrator!.provider,
                          provider,
                          draft.orchestrator!.model
                        )
                      }
                    })
                  }}
                >
                  {ORCHESTRATOR_PROVIDERS
                    .filter((p) => store.providerEnabled[p] || p === draft.orchestrator?.provider)
                    .map((p) => (
                    <option key={p} value={p}>
                      {PROVIDER_THEME[p].label}
                    </option>
                  ))}
                </select>
              </div>
              {draft.orchestrator.provider === 'claude' && (
                <div style={{ flex: 1.4 }}>
                  <div className="select-label">
                    Claude-Modus <InfoTip text={HELP.permissionMode} />
                  </div>
                  <ClaudePermissionModeSelect
                    id="orchestrator-permission-mode"
                    value={draft.orchestrator.permissionMode ?? 'default'}
                    onChange={(permissionMode) =>
                      patch({
                        orchestrator: { ...draft.orchestrator!, permissionMode }
                      })
                    }
                  />
                </div>
              )}
              <div style={{ flex: 0.9 }}>
                <div className="select-label">
                  Preset <InfoTip text={HELP.modelPreset} />
                </div>
                <select
                  className="select"
                  value={presetValue(draft.orchestrator.modelPreset)}
                  onChange={(e) =>
                    patch({
                      orchestrator: {
                        ...draft.orchestrator!,
                        modelPreset: parsePreset(e.target.value)
                      }
                    })
                  }
                >
                  <option value="">Legacy (CLI)</option>
                  {MODEL_PRESETS.map((preset) => {
                    const available = presetAvailable(draft.orchestrator!.provider, preset)
                    return (
                      <option key={preset} value={preset} disabled={!available}>
                        {MODEL_PRESET_LABELS[preset]}
                        {!available ? ' (nicht verfügbar)' : ''}
                      </option>
                    )
                  })}
                </select>
              </div>
              <div style={{ flex: 1 }}>
                <div className="select-label">
                  Modell <InfoTip text={HELP.model} />
                  <span className="model-count" title="verfügbare Modelle dieses Providers (frei eingebbar)">
                    {modelsFor(draft.orchestrator.provider).length}
                  </span>
                </div>
                <ModelCombo
                  className="select mono"
                  datalistId="orch-models"
                  models={modelsFor(draft.orchestrator.provider)}
                  value={draft.orchestrator.model}
                  onChange={(model) =>
                    patch({ orchestrator: { ...draft.orchestrator!, model } })
                  }
                />
                <ModelCatalogStatus
                  provider={draft.orchestrator.provider}
                  catalog={catalogFor(draft.orchestrator.provider)}
                />
                <div className="model-effective" aria-live="polite">
                  Effektiv:{' '}
                  {formatModelLabel(
                    resolveModel(draft.orchestrator.provider, draft.orchestrator),
                    draft.orchestrator
                  )}
                </div>
              </div>
              <div className="orch-note">steuert Subagents</div>
            </div>
          ) : (
            <div className="single-hint">
              Kein Orchestrator — beim Start laufen alle Subagent-Slots (mit ihrer Anzahl) parallel
              als eigenständige, interaktive Agents.
            </div>
          )}

          <section className="automation-section" aria-labelledby="planner-heading">
            <div className="slots-caption compact-caption">
              <span id="planner-heading">Auto-Subagent-Planer</span>
              <span className="count">entscheidet Parallelität und Re-Planning</span>
            </div>
            <div className="automation-grid">
              <label>
                <span className="slot-col-label">
                  Team-Start <InfoTip text={HELP.routingMode} />
                </span>
                <select
                  className="slot-select-sm"
                  value={draft.planner.routingMode}
                  onChange={(event) =>
                    patch({ planner: { ...draft.planner, routingMode: event.target.value as WorkspaceProfile['planner']['routingMode'] } })
                  }
                >
                  <option value="adaptive">Adaptiv — nach Plan aktivieren</option>
                  <option value="fixed">Vorgewärmt — alle Slots starten</option>
                </select>
              </label>
              <label>
                <span className="slot-col-label">
                  Planungsmodus <InfoTip text={HELP.plannerMode} />
                </span>
                <select
                  className="slot-select-sm"
                  value={draft.planner.mode}
                  onChange={(event) =>
                    patch({ planner: { ...draft.planner, mode: event.target.value as WorkspaceProfile['planner']['mode'] } })
                  }
                >
                  <option value="auto">Auto — direkt ausführen</option>
                  <option value="review">Review — Plan bestätigen</option>
                  <option value="manual">Manuell — keine Auto-Planung</option>
                </select>
              </label>
              <label>
                <span className="slot-col-label">
                  Max. parallel <InfoTip text={HELP.maxParallel} />
                </span>
                <input
                  className="slot-select-sm"
                  type="number"
                  min={1}
                  max={32}
                  value={draft.planner.maxParallel}
                  onChange={(event) => patch({ planner: { ...draft.planner, maxParallel: boundedNumber(event.currentTarget.valueAsNumber, 1, 32, draft.planner.maxParallel) } })}
                />
              </label>
              <label>
                <span className="slot-col-label">
                  Re-Plan-Versuche <InfoTip text={HELP.maxRetries} />
                </span>
                <input
                  className="slot-select-sm"
                  type="number"
                  min={0}
                  max={5}
                  value={draft.planner.maxRetries}
                  onChange={(event) => patch({
                    planner: {
                      ...draft.planner,
                      maxRetries: boundedNumber(event.currentTarget.valueAsNumber, 0, 5, draft.planner.maxRetries)
                    }
                  })}
                />
              </label>
              <label>
                <span className="slot-col-label">
                  Auto-Benchmark <InfoTip text={HELP.benchmark} />
                </span>
                <select
                  className="slot-select-sm"
                  value={draft.benchmark.enabled ? 'on' : 'off'}
                  disabled={!draft.orchestrator}
                  title={!draft.orchestrator ? 'Auto-Benchmark benötigt einen Orchestrator.' : undefined}
                  onChange={(event) =>
                    patch({ benchmark: { enabled: event.target.value === 'on' } })
                  }
                >
                  <option value="off">Aus</option>
                  <option value="on">Aktiv — gleiche Aufgabe für alle Slots</option>
                </select>
              </label>
              <label>
                <span className="slot-col-label">
                  Multiagent-Modus <InfoTip text={HELP.multiAgent} />
                </span>
                <select
                  className="slot-select-sm"
                  value={draft.multiAgent.enabled ? 'on' : 'off'}
                  disabled={!draft.orchestrator}
                  title={!draft.orchestrator ? 'Multiagent-Modus benötigt einen Orchestrator.' : undefined}
                  onChange={(event) => patch({
                    multiAgent: { ...draft.multiAgent, enabled: event.target.value === 'on' }
                  })}
                >
                  <option value="off">Aus — ein Agent je Task</option>
                  <option value="on">Aktiv — Slot-Anzahl als Kandidaten</option>
                </select>
              </label>
            </div>
          </section>

          <section className="automation-section" aria-labelledby="auto-pr-heading">
            <div className="slots-caption compact-caption">
              <span id="auto-pr-heading">Auto-PR</span>
              <span className="count">nur nach erfolgreichen Quality Gates</span>
            </div>
            <div className="automation-grid auto-pr-grid">
              <label>
                <span className="slot-col-label">
                  Modus <InfoTip text={HELP.autoPrMode} />
                </span>
                <select
                  className="slot-select-sm"
                  value={draft.autoPr.mode}
                  onChange={(event) =>
                    patch({ autoPr: { ...draft.autoPr, mode: event.target.value as WorkspaceProfile['autoPr']['mode'] } })
                  }
                >
                  <option value="off">Aus</option>
                  <option value="draft-after-checks">Draft nach Checks</option>
                  <option value="ready-after-checks">Ready nach Checks</option>
                  <option value="hold-for-approval">Vor Veröffentlichung freigeben</option>
                </select>
              </label>
              <label>
                <span className="slot-col-label">
                  PR-Strategie <InfoTip text={HELP.prStrategy} />
                </span>
                <select
                  className="slot-select-sm"
                  value={draft.autoPr.strategy}
                  onChange={(event) =>
                    patch({ autoPr: { ...draft.autoPr, strategy: event.target.value as WorkspaceProfile['autoPr']['strategy'] } })
                  }
                >
                  <option value="aggregate">Ein gemeinsamer PR</option>
                  <option value="per-task">Ein PR je Task</option>
                </select>
              </label>
              <label>
                <span className="slot-col-label">
                  Basis-Branch <InfoTip text={HELP.baseBranch} />
                </span>
                <input
                  className="slot-select-sm mono"
                  placeholder={
                    draft.githubRepo?.defaultBranch ||
                    draft.autoPr.baseBranch ||
                    'Gebundener Standardbranch'
                  }
                  value={draft.autoPr.baseBranch}
                  onChange={(event) => patch({ autoPr: { ...draft.autoPr, baseBranch: event.target.value } })}
                />
              </label>
              <label className="quality-gates-field">
                <span className="slot-col-label">
                  Quality Gates (eine Zeile je Befehl) <InfoTip text={HELP.qualityGates} />
                </span>
                <textarea
                  className="text-input mono quality-gates"
                  value={draft.autoPr.qualityGates.join('\n')}
                  onChange={(event) =>
                    patch({
                      autoPr: {
                        ...draft.autoPr,
                        qualityGates: event.target.value.split('\n').map((line) => line.trim()).filter(Boolean)
                      }
                    })
                  }
                />
              </label>
            </div>
          </section>
          <section className="automation-section" aria-labelledby="auto-git-heading">
            <div className="slots-caption compact-caption">
              <span id="auto-git-heading">Auto-Commit &amp; Push</span>
              <span className="count">nur nach vollständig erfolgreichem Lauf</span>
            </div>
            <div className="automation-grid auto-git-grid">
              <label>
                <span className="slot-col-label">
                  Modus <InfoTip text={HELP.autoGitMode} />
                </span>
                <select
                  className="slot-select-sm"
                  value={draft.autoGit.enabled ? 'on' : 'off'}
                  onChange={(event) => patch({
                    autoGit: { ...draft.autoGit, enabled: event.target.value === 'on' }
                  })}
                >
                  <option value="off">Aus</option>
                  <option value="on">Nach Erfolg committen &amp; pushen</option>
                </select>
              </label>
              <label>
                <span className="slot-col-label">
                  Ziel-Branch <InfoTip text={HELP.autoGitBranch} />
                </span>
                <input
                  className={`slot-select-sm mono ${autoGitBranchError ? 'input-invalid' : ''}`}
                  placeholder="z. B. vertragus/integrated"
                  value={draft.autoGit.targetBranch}
                  aria-invalid={Boolean(autoGitBranchError)}
                  aria-describedby={autoGitBranchError ? 'auto-git-branch-error' : undefined}
                  onChange={(event) => patch({
                    autoGit: { ...draft.autoGit, targetBranch: event.target.value }
                  })}
                />
              </label>
            </div>
            {autoGitBranchError && (
              <div id="auto-git-branch-error" className="automation-validation-error" role="alert">
                {autoGitBranchError}
              </div>
            )}
          </section>
          <div className="slots-caption">
            <span>Subagent-Slots</span>
            <span className="count">
              {draft.agents.length} Slots · {subTotal} Agents
            </span>
          </div>

          <div className="slot-list">
            {draft.agents.map((slot, idx) => (
              <div className="slot-row" key={idx}>
                <div className="slot-role-field">
                  <div className="slot-col-label">Rolle / Label <InfoTip text={HELP.role} /></div>
                  <input
                    className="slot-role-input"
                    value={slot.role}
                    placeholder={slot.provider}
                    onChange={(e) => patchSlot(idx, { role: e.target.value })}
                  />
                </div>
                <div className="slot-fields">
                <div style={{ flex: 1.1 }}>
                  <div className="slot-col-label">
                    Provider <InfoTip text={HELP.agentProvider} />
                  </div>
                  <select
                    className="slot-select-sm"
                    value={slot.provider}
                    onChange={(e) => {
                      const provider = e.target.value as AgentProviderId
                      // Clear the explicit override only on a real provider
                      // switch, so the preset resolves against the new provider.
                      // A same-provider reselect keeps the saved model.
                      patchSlot(idx, {
                        provider,
                        model: modelAfterProviderChange(slot.provider, provider, slot.model)
                      })
                    }}
                  >
                    {AGENT_PROVIDERS
                      .filter((p) => store.providerEnabled[p] || p === slot.provider)
                      .map((p) => (
                      <option key={p} value={p}>
                        {PROVIDER_THEME[p].label}
                      </option>
                    ))}
                  </select>
                </div>
                <div style={{ flex: 0.85 }}>
                  <div className="slot-col-label">
                    Preset <InfoTip text={HELP.modelPreset} />
                  </div>
                  <select
                    className="slot-select-sm"
                    value={presetValue(slot.modelPreset)}
                    onChange={(e) => patchSlot(idx, { modelPreset: parsePreset(e.target.value) })}
                  >
                    <option value="">Legacy (CLI)</option>
                    {MODEL_PRESETS.map((preset) => {
                      const available = presetAvailable(slot.provider, preset)
                      return (
                        <option key={preset} value={preset} disabled={!available}>
                          {MODEL_PRESET_LABELS[preset]}
                          {!available ? ' (nicht verfügbar)' : ''}
                        </option>
                      )
                    })}
                  </select>
                </div>
                <div style={{ flex: 1.4 }}>
                  <div className="slot-col-label">
                    Modell <InfoTip text={HELP.model} />
                    <span className="model-count" title="verfügbare Modelle dieses Providers (frei eingebbar)">
                      {modelsFor(slot.provider).length}
                    </span>
                  </div>
                  <ModelCombo
                    className="slot-select-sm mono"
                    datalistId={`slot-models-${idx}`}
                    models={modelsFor(slot.provider)}
                    value={slot.model}
                    onChange={(model) => patchSlot(idx, { model })}
                  />
                  <ModelCatalogStatus provider={slot.provider} catalog={catalogFor(slot.provider)} />
                  <div className="model-effective" aria-live="polite">
                    Effektiv: {formatModelLabel(resolveModel(slot.provider, slot), slot)}
                  </div>
                </div>
                <div style={{ flex: 'none' }}>
                  <div className="slot-col-label" style={{ textAlign: 'center' }}>
                    Anzahl <InfoTip text={HELP.count} />
                  </div>
                  <div className="stepper">
                    <button type="button" onClick={() => patchSlot(idx, { count: Math.max(1, slot.count - 1) })}>
                      −
                    </button>
                    <span className="val">{slot.count}</span>
                    <button type="button" onClick={() => patchSlot(idx, { count: slot.count + 1 })}>
                      +
                    </button>
                  </div>
                </div>
                <div style={{ flex: 'none', textAlign: 'center' }}>
                  <div className="slot-col-label">
                    Yolo <InfoTip text={HELP.yolo} />
                  </div>
                  <button type="button"
                    className={`slot-yolo ${slot.yolo ? 'on' : ''}`}
                    onClick={() => patchSlot(idx, { yolo: !slot.yolo })}
                  >
                    <span className="knob" />
                  </button>
                </div>
                <div style={{ flex: 'none', textAlign: 'center' }}>
                  <div className="slot-col-label">steuerbar <InfoTip text={HELP.orchestrated} /></div>
                  <button type="button"
                    className={`ctrl-check ${slot.orchestrated ? 'on' : ''}`}
                    onClick={() => patchSlot(idx, { orchestrated: !slot.orchestrated })}
                  >
                    {slot.orchestrated ? '✓' : ''}
                  </button>
                </div>
                <button type="button"
                  className="slot-remove"
                  title="Slot entfernen"
                  onClick={() =>
                    setDraft({ ...draft, agents: draft.agents.filter((_, i) => i !== idx) })
                  }
                >
                  ✕
                </button>
                </div>
                <MultiAgentOverrideSelect
                  id={`slot-multi-agent-${idx}`}
                  value={slot.multiAgent}
                  globalEnabled={draft.multiAgent.enabled}
                  onChange={(choice) => patchSlotMultiAgent(idx, choice)}
                />
                <div className="slot-path-row">
                  <div className="slot-path-field">
                    <div className="slot-col-label">
                      Eigener Pfad (optional) <InfoTip text={HELP.agentWorkingDir} />
                    </div>
                    <input
                      className="slot-select-sm mono"
                      placeholder={draft.workingDir || 'Workspace-Basispfad'}
                      value={slot.workingDir ?? ''}
                      onChange={(event) =>
                        patchSlot(idx, { workingDir: event.target.value || undefined })
                      }
                    />
                  </div>
                  <button
                    type="button"
                    className="btn-secondary slot-browse-btn"
                    onClick={async () => {
                      const dir = await window.vertragus.pickFolder()
                      if (dir) patchSlot(idx, { workingDir: dir })
                    }}
                  >
                    Durchsuchen…
                  </button>
                </div>
                <div className="slot-path-row">
                  <div className="slot-path-field">
                    <div className="slot-col-label">
                      Stärken (optional) <InfoTip text={HELP.strengths} />
                    </div>
                    <input
                      className="slot-select-sm"
                      placeholder="z. B. Frontend, Tests, Security-Review"
                      value={slot.strengths.join(', ')}
                      onChange={(event) =>
                        patchSlot(idx, { strengths: parseCapabilityList(event.target.value) })
                      }
                    />
                  </div>
                  <div className="slot-path-field">
                    <div className="slot-col-label">
                      Schwächen (optional) <InfoTip text={HELP.weaknesses} />
                    </div>
                    <input
                      className="slot-select-sm"
                      placeholder="z. B. große Refactorings"
                      value={slot.weaknesses.join(', ')}
                      onChange={(event) =>
                        patchSlot(idx, { weaknesses: parseCapabilityList(event.target.value) })
                      }
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>

          <button type="button"
            className="add-slot"
            onClick={() =>
              setDraft({
                ...draft,
                agents: [
                  ...draft.agents,
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
              })
            }
          >
            ＋ Slot hinzufügen
          </button>
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
