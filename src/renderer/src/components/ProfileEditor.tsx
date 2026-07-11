import { useState } from 'react'
import { useAppStore } from '@renderer/store/useAppStore'
import type { WorkspaceProfile, AgentSlot } from '@shared/profile'
import type { AgentProviderId } from '@shared/providers'
import { PROVIDER_THEME } from '@renderer/ui/theme'

const AGENT_PROVIDERS: AgentProviderId[] = ['claude', 'codex', 'cursor', 'ollama']

export default function ProfileEditor(): JSX.Element | null {
  const store = useAppStore()
  const initial = store.editorProfile
  const [draft, setDraft] = useState<WorkspaceProfile | null>(initial)

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
      <div className="modal">
        <div className="modal-head">
          <span className="modal-gear">⚙</span>
          <div style={{ flex: 1 }}>
            <div className="modal-title">Profil-Editor</div>
            <div className="modal-sub">Orchestrator &amp; Subagent-Slots konfigurieren</div>
          </div>
          <button className="modal-close" onClick={store.closeEditor}>
            ✕
          </button>
        </div>

        <div className="modal-body">
          <label className="field-label">Profilname</label>
          <input
            className="text-input"
            value={draft.name}
            onChange={(e) => patch({ name: e.target.value })}
          />

          <label className="field-label">Working Directory (Repo)</label>
          <input
            className="text-input mono"
            placeholder="C:\git\mein-repo"
            value={draft.workingDir}
            onChange={(e) => patch({ workingDir: e.target.value })}
          />

          <div className="field-label" style={{ marginBottom: 8 }}>
            Orchestrator
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
                  {AGENT_PROVIDERS.map((p) => (
                    <option key={p} value={p}>
                      {PROVIDER_THEME[p].label}
                    </option>
                  ))}
                </select>
              </div>
              <div style={{ flex: 1 }}>
                <div className="select-label">Modell</div>
                <select
                  className="select mono"
                  value={draft.orchestrator.model}
                  onChange={(e) =>
                    patch({ orchestrator: { ...draft.orchestrator!, model: e.target.value } })
                  }
                >
                  {[
                    ...new Set([draft.orchestrator.model, ...modelsFor(draft.orchestrator.provider)])
                  ].map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
              <div className="orch-note">steuert Subagents</div>
              <button
                className="slot-remove"
                title="Orchestrator entfernen"
                onClick={() => patch({ orchestrator: undefined })}
              >
                ✕
              </button>
            </div>
          ) : (
            <button
              className="add-slot"
              style={{ marginTop: 0, marginBottom: 20 }}
              onClick={() =>
                patch({
                  orchestrator: {
                    provider: 'claude',
                    model: modelsFor('claude')[0] ?? 'fable',
                    autoOpenSubwindows: true
                  }
                })
              }
            >
              ＋ Orchestrator hinzufügen
            </button>
          )}

          <div className="slots-caption">
            <span>Subagent-Slots</span>
            <span className="count">
              {draft.agents.length} Slots · {subTotal} Agents
            </span>
          </div>

          <div className="slot-list">
            {draft.agents.map((slot, idx) => (
              <div className="slot-row" key={idx}>
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
                  <select
                    className="slot-select-sm mono"
                    value={slot.model}
                    onChange={(e) => patchSlot(idx, { model: e.target.value })}
                  >
                    {[...new Set([slot.model, ...modelsFor(slot.provider)])].map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </div>
                <div style={{ flex: 'none' }}>
                  <div className="slot-col-label" style={{ textAlign: 'center' }}>
                    Anzahl
                  </div>
                  <div className="stepper">
                    <button onClick={() => patchSlot(idx, { count: Math.max(1, slot.count - 1) })}>
                      −
                    </button>
                    <span className="val">{slot.count}</span>
                    <button onClick={() => patchSlot(idx, { count: Math.min(9, slot.count + 1) })}>
                      +
                    </button>
                  </div>
                </div>
                <div style={{ flex: 'none', textAlign: 'center' }}>
                  <div className="slot-col-label">Yolo</div>
                  <button
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
                  <button
                    className={`ctrl-check ${slot.orchestrated ? 'on' : ''}`}
                    onClick={() => patchSlot(idx, { orchestrated: !slot.orchestrated })}
                  >
                    {slot.orchestrated ? '✓' : ''}
                  </button>
                </div>
                <button
                  className="slot-remove"
                  title="Slot entfernen"
                  onClick={() =>
                    setDraft({ ...draft, agents: draft.agents.filter((_, i) => i !== idx) })
                  }
                >
                  ✕
                </button>
              </div>
            ))}
          </div>

          <button
            className="add-slot"
            onClick={() =>
              setDraft({
                ...draft,
                agents: [
                  ...draft.agents,
                  {
                    role: 'worker',
                    provider: 'codex',
                    model: modelsFor('codex')[0] ?? 'gpt-5.6',
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
          <button className="btn-secondary" onClick={store.closeEditor}>
            Abbrechen
          </button>
          <button className="btn-primary" onClick={() => void store.saveEditor(draft)}>
            Profil speichern
          </button>
        </div>
      </div>
    </div>
  )
}
