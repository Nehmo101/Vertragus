import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '@renderer/store/useAppStore'
import type { WorkspaceProfile, AgentSlot } from '@shared/profile'
import type { AgentProviderId } from '@shared/providers'
import type { GithubProjectSummary } from '@shared/ipc'
import { PROVIDER_THEME } from '@renderer/ui/theme'
import InfoTip from '@renderer/components/InfoTip'

const AGENT_PROVIDERS: AgentProviderId[] = ['claude', 'codex', 'cursor', 'copilot', 'ollama']

const ORCHESTRATOR_PROVIDERS: AgentProviderId[] = ['claude', 'codex']
const HELP = {
  profileName: 'Frei wählbarer Name für diese Kombination aus Workspace, Orchestrator und Subagents.',
  workingDir: 'Repository oder Ordner, in dem Agents arbeiten. Task-Worktrees werden von diesem Git-Repository abgeleitet.',
  githubProject: 'Optionales GitHub Projects Board für diesen Workspace. Der Owner wird aus origin erkannt oder kann manuell gesetzt werden.',
  agentWorkingDir: 'Optionaler Pfad nur für diesen Slot. Leer übernimmt den Workspace-Basispfad.',
  mode: 'Orchestriert lässt Claude oder Codex planen und delegieren. Single startet nur die konfigurierten Slots.',
  orchestratorProvider: 'Nur Provider mit verifiziertem Orca-MCP-Adapter können orchestrieren.',
  model: 'Leer verwendet den Standard der jeweiligen CLI. Eine Modell-ID muss für dein Konto verfügbar sein.',
  plannerMode: 'Auto startet valide Pläne direkt. Review wartet auf Freigabe. Manuell deaktiviert execute_plan.',
  maxParallel: 'Globales Oberlimit gleichzeitig laufender Plan-Tasks; Rollen-Kapazitäten können es weiter reduzieren.',
  autoPrMode: 'PRs entstehen nur nach erfolgreichen Gates. Draft ist der empfohlene sichere Startmodus.',
  prStrategy: 'Aggregate kombiniert Task-Commits in einen Goal-PR. Per Task erzeugt getrennte PRs.',
  baseBranch: 'Zielbranch des PRs. Leer nutzt den Standardbranch des origin-Remotes.',
  qualityGates: 'Vertrauenswürdige Shell-Befehle, die im Task- und Integrations-Worktree erfolgreich laufen müssen.',
  role: 'Eindeutige Fähigkeit, die der Planner adressiert, etwa frontend, backend, tests oder review.',
  agentProvider: 'CLI, die diesen Slot ausführt. Der Login erfolgt separat in der Provider-Seitenleiste.',
  count: 'Maximale parallele Task-Kapazität dieser Rolle und Anzahl beim manuellen Teamstart.',
  yolo: 'Überspringt Provider-Bestätigungen. Nur mit Worktree-Isolation und bewusstem Scope verwenden.',
  orchestrated: 'Wenn aktiv, darf der Orchestrator Aufgaben an diesen Slot delegieren.'
} as const
function boundedNumber(value: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
}
function projectKey(project: Pick<GithubProjectSummary, 'owner' | 'number'>): string {
  return `${project.owner}#${project.number}`
}

export default function ProfileEditor(): JSX.Element | null {
  const store = useAppStore()
  const initial = store.editorProfile
  const [draft, setDraft] = useState<WorkspaceProfile | null>(initial)
  const [projectOwner, setProjectOwner] = useState(initial?.githubProject?.owner ?? '')
  const [projects, setProjects] = useState<GithubProjectSummary[]>(
    initial?.githubProject ? [{ ...initial.githubProject, closed: false }] : []
  )
  const [projectsStatus, setProjectsStatus] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const closeEditor = store.closeEditor

  useEffect(() => {
    nameRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeEditor()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [closeEditor])

  if (!initial || !draft) return null

  const models = store.models
  const modelsFor = (p: AgentProviderId): string[] => models[p] ?? []
  // codex defaults to empty = its own configured default (an explicit
  // unsupported model 400s); other providers default to their first suggestion.
  const defaultModelFor = (p: AgentProviderId): string => (p === 'codex' ? '' : modelsFor(p)[0] ?? '')

  const patch = (p: Partial<WorkspaceProfile>): void => setDraft({ ...draft, ...p })
  const patchSlot = (idx: number, p: Partial<AgentSlot>): void => {
    const agents = draft.agents.map((s, i) => (i === idx ? { ...s, ...p } : s))
    setDraft({ ...draft, agents })
  }
  const loadProjects = async (): Promise<void> => {
    setProjectsStatus('GitHub-Boards werden geladen…')
    try {
      const result = await window.orca.githubProjects(draft.workingDir, projectOwner || undefined)
      setProjectOwner(result.owner)
      setProjects(result.projects)
      setProjectsStatus(
        result.projects.length === 0
          ? `Keine offenen Boards für ${result.owner} gefunden.`
          : `${result.projects.length} Board(s) geladen.`
      )
    } catch (error) {
      setProjectsStatus(error instanceof Error ? error.message : String(error))
    }
  }

  const projectOptions =
    draft.githubProject && !projects.some((project) => projectKey(project) === projectKey(draft.githubProject!))
      ? [{ ...draft.githubProject, closed: false }, ...projects]
      : projects

  const subTotal = draft.agents.reduce((n, s) => n + s.count, 0)
  const hasOrch = Boolean(draft.orchestrator)
  const grandTotal = subTotal + (hasOrch ? 1 : 0)
  const isSavedProfile = store.profiles.some((profile) => profile.id === draft.id)
  const hasRunningAgents = store.agents.some(
    (agent) => agent.status === 'running' || agent.status === 'waiting'
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
                const dir = await window.orca.pickFolder()
                if (dir) patch({ workingDir: dir })
              }}
            >
              Durchsuchen…
            </button>
          </div>
          <section className="github-project-field" aria-labelledby="github-project-heading">
            <div className="field-label" id="github-project-heading">
              GitHub Board <InfoTip text={HELP.githubProject} />
            </div>
            <div className="github-project-owner-row">
              <input
                className="text-input mono"
                placeholder="Owner automatisch aus origin"
                aria-label="GitHub-Owner"
                value={projectOwner}
                onChange={(event) => setProjectOwner(event.target.value)}
              />
              <button
                type="button"
                className="btn-secondary browse-btn"
                disabled={!draft.workingDir.trim() && !projectOwner.trim()}
                onClick={() => void loadProjects()}
              >
                Boards laden
              </button>
            </div>
            <select
              className="select github-project-select"
              aria-label="GitHub Board für Workspace"
              value={draft.githubProject ? projectKey(draft.githubProject) : ''}
              onChange={(event) => {
                const selected = projectOptions.find(
                  (project) => projectKey(project) === event.target.value
                )
                patch({
                  githubProject: selected
                    ? {
                        owner: selected.owner,
                        number: selected.number,
                        title: selected.title,
                        url: selected.url
                      }
                    : undefined
                })
              }}
            >
              <option value="">Kein Board</option>
              {projectOptions.map((project) => (
                <option key={projectKey(project)} value={projectKey(project)}>
                  {project.title} (#{project.number})
                </option>
              ))}
            </select>
            <div className="github-project-status" aria-live="polite">
              {projectsStatus ||
                (draft.githubProject
                  ? `${draft.githubProject.owner} · #${draft.githubProject.number}`
                  : 'Owner leer lassen, um ihn aus dem GitHub-origin zu erkennen.')}
            </div>
          </section>

          <div className="field-label" style={{ marginBottom: 8 }}>
            Modus <InfoTip text={HELP.mode} />
          </div>
          <div className="mode-toggle">
            <button type="button"
              className={draft.orchestrator ? 'active' : ''}
              onClick={() =>
                !draft.orchestrator &&
                patch({
                  orchestrator: {
                    provider: 'claude',
                    model: modelsFor('claude')[0] ?? 'fable',
                    autoOpenSubwindows: true
                  }
                })
              }
            >
              🪄 Orchestriert
              <span>ein Orchestrator delegiert an Subagents</span>
            </button>
            <button type="button"
              className={!draft.orchestrator ? 'active' : ''}
              onClick={() => patch({ orchestrator: undefined })}
            >
              ⚡ Single
              <span>alle Slots laufen parallel, kein Orchestrator</span>
            </button>
          </div>
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
                        model: defaultModelFor(provider)
                      }
                    })
                  }}
                >
                  {ORCHESTRATOR_PROVIDERS.map((p) => (
                    <option key={p} value={p}>
                      {PROVIDER_THEME[p].label}
                    </option>
                  ))}
                </select>
              </div>
              <div style={{ flex: 1 }}>
                <div className="select-label">
                  Modell <InfoTip text={HELP.model} />
                  <span className="model-count" title="verfügbare Modelle dieses Providers (frei eingebbar)">
                    {modelsFor(draft.orchestrator.provider).length}
                  </span>
                </div>
                <input
                  className="select mono"
                  list="orch-models"
                  placeholder="CLI-Standard"
                  value={draft.orchestrator.model}
                  onChange={(e) =>
                    patch({ orchestrator: { ...draft.orchestrator!, model: e.target.value } })
                  }
                />
                <datalist id="orch-models">
                  {modelsFor(draft.orchestrator.provider).map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
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
                  placeholder="Repo-Standard"
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
                      patchSlot(idx, { provider, model: defaultModelFor(provider) })
                    }}
                  >
                    {AGENT_PROVIDERS.map((p) => (
                      <option key={p} value={p}>
                        {PROVIDER_THEME[p].label}
                      </option>
                    ))}
                  </select>
                </div>
                <div style={{ flex: 1.4 }}>
                  <div className="slot-col-label">
                    Modell <InfoTip text={HELP.model} />
                    <span className="model-count" title="verfügbare Modelle dieses Providers (frei eingebbar)">
                      {modelsFor(slot.provider).length}
                    </span>
                  </div>
                  <input
                    className="slot-select-sm mono"
                    list={`slot-models-${idx}`}
                    placeholder="CLI-Standard"
                    value={slot.model}
                    onChange={(e) => patchSlot(idx, { model: e.target.value })}
                  />
                  <datalist id={`slot-models-${idx}`}>
                    {modelsFor(slot.provider).map((m) => (
                      <option key={m} value={m} />
                    ))}
                  </datalist>
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
                    <button type="button" onClick={() => patchSlot(idx, { count: Math.min(9, slot.count + 1) })}>
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
                      const dir = await window.orca.pickFolder()
                      if (dir) patchSlot(idx, { workingDir: dir })
                    }}
                  >
                    Durchsuchen…
                  </button>
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
                    model: defaultModelFor('codex'),
                    count: 1,
                    orchestrated: true,
                    yolo: false
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
              className="btn-danger modal-delete-btn"
              disabled={hasRunningAgents}
              title={hasRunningAgents ? 'Während einer laufenden Agent-Session nicht verfügbar' : 'Profil löschen'}
              onClick={() => setConfirmDelete(true)}
            >
              Profil löschen
            </button>
          )}
          <button type="button" className="btn-secondary" onClick={store.closeEditor}>
            Abbrechen
          </button>
          <button type="button" className="btn-primary" onClick={() => void store.saveEditor(draft)}>
            Profil speichern
          </button>
        </div>
      </div>
    </div>
  )
}
