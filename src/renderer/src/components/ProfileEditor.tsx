import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '@renderer/store/useAppStore'
import type { WorkspaceProfile, AgentSlot } from '@shared/profile'
import type { AgentProviderId } from '@shared/providers'
import { PROVIDER_THEME } from '@renderer/ui/theme'

const AGENT_PROVIDERS: AgentProviderId[] = ['claude', 'codex', 'cursor', 'ollama']

const ORCHESTRATOR_PROVIDERS: AgentProviderId[] = ['claude', 'codex']
function boundedNumber(value: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
}

export default function ProfileEditor(): JSX.Element | null {
  const store = useAppStore()
  const initial = store.editorProfile
  const [draft, setDraft] = useState<WorkspaceProfile | null>(initial)
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

  const patch = (p: Partial<WorkspaceProfile>): void => setDraft({ ...draft, ...p })
  const patchSlot = (idx: number, p: Partial<AgentSlot>): void => {
    const agents = draft.agents.map((s, i) => (i === idx ? { ...s, ...p } : s))
    setDraft({ ...draft, agents })
  }

  const subTotal = draft.agents.reduce((n, s) => n + s.count, 0)
  const hasOrch = Boolean(draft.orchestrator)
  const grandTotal = subTotal + (hasOrch ? 1 : 0)

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
          <label className="field-label" htmlFor="profile-name">Profilname</label>
          <input
            ref={nameRef}
            id="profile-name"
            className="text-input"
            value={draft.name}
            onChange={(e) => patch({ name: e.target.value })}
          />

          <label className="field-label" htmlFor="profile-working-dir">Working Directory (Repo)</label>
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

          <div className="field-label" style={{ marginBottom: 8 }}>
            Modus
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
                <div className="select-label">Provider</div>
                <select
                  className="select"
                  value={draft.orchestrator.provider}
                  onChange={(e) => {
                    const provider = e.target.value as AgentProviderId
                    patch({
                      orchestrator: {
                        ...draft.orchestrator!,
                        provider,
                        model: modelsFor(provider)[0] ?? ''
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
                <div className="select-label">Modell</div>
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
                <span className="slot-col-label">Planungsmodus</span>
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
                <span className="slot-col-label">Max. parallel</span>
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
                <span className="slot-col-label">Timeout (Min.)</span>
                <input
                  className="slot-select-sm"
                  type="number"
                  min={1}
                  max={240}
                  value={draft.planner.taskTimeoutMinutes}
                  onChange={(event) => patch({ planner: { ...draft.planner, taskTimeoutMinutes: boundedNumber(event.currentTarget.valueAsNumber, 1, 240, draft.planner.taskTimeoutMinutes) } })}
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
                <span className="slot-col-label">Modus</span>
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
                <span className="slot-col-label">PR-Strategie</span>
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
                <span className="slot-col-label">Basis-Branch</span>
                <input
                  className="slot-select-sm mono"
                  placeholder="Repo-Standard"
                  value={draft.autoPr.baseBranch}
                  onChange={(event) => patch({ autoPr: { ...draft.autoPr, baseBranch: event.target.value } })}
                />
              </label>
              <label className="quality-gates-field">
                <span className="slot-col-label">Quality Gates (eine Zeile je Befehl)</span>
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
                  <div className="slot-col-label" title="Name, mit dem der Orchestrator diesen Slot gezielt anspricht">
                    Rolle / Label
                  </div>
                  <input
                    className="slot-role-input"
                    value={slot.role}
                    placeholder={slot.provider}
                    onChange={(e) => patchSlot(idx, { role: e.target.value })}
                  />
                </div>
                <div className="slot-fields">
                <div style={{ flex: 1.1 }}>
                  <div className="slot-col-label">Provider</div>
                  <select
                    className="slot-select-sm"
                    value={slot.provider}
                    onChange={(e) => {
                      const provider = e.target.value as AgentProviderId
                      patchSlot(idx, { provider, model: modelsFor(provider)[0] ?? '' })
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
                  <div className="slot-col-label">Modell</div>
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
                    Anzahl
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
                  <div className="slot-col-label">Yolo</div>
                  <button type="button"
                    className={`slot-yolo ${slot.yolo ? 'on' : ''}`}
                    onClick={() => patchSlot(idx, { yolo: !slot.yolo })}
                  >
                    <span className="knob" />
                  </button>
                </div>
                <div style={{ flex: 'none', textAlign: 'center' }}>
                  <div className="slot-col-label" title="vom Orchestrator steuerbar">
                    steuerbar
                  </div>
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
                    model: modelsFor('codex')[0] ?? '',
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

        <div className="modal-foot">
          <div className="totals">
            Gesamt: <b>{hasOrch ? 1 : 0}</b> Orchestrator + <b>{subTotal}</b> Subagents ={' '}
            <b className="grand">{grandTotal} Agents</b>
          </div>
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
