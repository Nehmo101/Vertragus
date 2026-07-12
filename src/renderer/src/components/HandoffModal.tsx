import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '@renderer/store/useAppStore'
import { LIMIT_KIND_LABELS } from '@shared/agents'
import type { AgentProviderId } from '@shared/providers'
import { PROVIDER_THEME } from '@renderer/ui/theme'

const AGENT_PROVIDERS: AgentProviderId[] = ['claude', 'codex', 'cursor', 'ollama']

export default function HandoffModal(): JSX.Element | null {
  const store = useAppStore()
  const source = store.handoffSource
  const closeHandoff = store.closeHandoff
  const models = store.models
  const modelsFor = (p: AgentProviderId): string[] => models[p] ?? []
  // codex defaults to the empty CLI-default (an explicit unsupported name 400s).
  const defaultModelFor = (p: AgentProviderId): string => (p === 'codex' ? '' : modelsFor(p)[0] ?? '')

  const [provider, setProvider] = useState<AgentProviderId>('codex')
  const [model, setModel] = useState<string>(defaultModelFor('codex'))
  const [task, setTask] = useState<string>(store.orchestrator.goal?.title ?? '')
  const [summary, setSummary] = useState<string>('')
  const taskRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    taskRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeHandoff()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [closeHandoff])

  if (!source) return null

  const limit = source.limitWarning
  const srcTheme = PROVIDER_THEME[source.provider]

  const submit = (): void => {
    void store.handoff({ sourceId: source.id, provider, model, task, summary })
  }

  return (
    <div className="modal-wrap">
      <div className="modal-scrim" onClick={closeHandoff} />
      <div className="modal handoff-modal" role="dialog" aria-modal="true" aria-labelledby="handoff-title">
        <div className="modal-head">
          <span className="modal-gear">⇄</span>
          <div style={{ flex: 1 }}>
            <div className="modal-title" id="handoff-title">Agent-Übergabe</div>
            <div className="modal-sub">Laufende Arbeit an einen neuen Agent vererben</div>
          </div>
          <button type="button" className="modal-close" aria-label="Übergabe schließen" onClick={closeHandoff}>
            ✕
          </button>
        </div>

        <div className="modal-body">
          <div className="handoff-source">
            <span className="chip sz-27" style={{ background: srcTheme.bg, color: srcTheme.fg }}>
              {srcTheme.mono}
            </span>
            <div className="info">
              <div className="name">
                {source.name}
                <span className="sub"> · {srcTheme.label}/{source.model || 'CLI-Standard'}</span>
              </div>
              <div className="reason">
                {limit ? `⚠ ${LIMIT_KIND_LABELS[limit.kind]} erkannt` : 'manuelle Übergabe'} — {source.role}
              </div>
            </div>
          </div>

          <div className="handoff-target-row">
            <div style={{ flex: 1 }}>
              <div className="select-label">Ziel-Provider</div>
              <select
                className="slot-select-sm"
                value={provider}
                onChange={(e) => {
                  const p = e.target.value as AgentProviderId
                  setProvider(p)
                  setModel(defaultModelFor(p))
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
              <div className="select-label">Modell</div>
              <input
                className="slot-select-sm mono"
                list="handoff-models"
                placeholder="CLI-Standard"
                value={model}
                onChange={(e) => setModel(e.target.value)}
              />
              <datalist id="handoff-models">
                {modelsFor(provider).map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </div>
          </div>

          <label className="field-label" htmlFor="handoff-task">Aufgabe (für den neuen Agent)</label>
          <textarea
            id="handoff-task"
            ref={taskRef}
            className="text-input handoff-text"
            placeholder="Was soll der neue Agent fertigstellen?"
            value={task}
            onChange={(e) => setTask(e.target.value)}
          />

          <label className="field-label" htmlFor="handoff-summary">Aktueller Stand (optional)</label>
          <textarea
            id="handoff-summary"
            className="text-input handoff-text"
            placeholder="Kurzer Vermerk, was schon erledigt ist / wo weitergemacht werden soll."
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
          />

          <div className="handoff-note">
            Der bisherige Terminal-Verlauf von {source.name} wird automatisch als Übergabe-Notiz
            angehängt. Der neue Agent startet in {source.name}s Arbeitsverzeichnis und macht dort
            weiter. {source.name} läuft weiter und wird als „übergeben" markiert.
          </div>
        </div>

        <div className="modal-foot">
          <div className="spacer" />
          <button type="button" className="btn-secondary" onClick={closeHandoff}>
            Abbrechen
          </button>
          <button type="button" className="btn-primary" onClick={submit}>
            ⇄ Übergeben
          </button>
        </div>
      </div>
    </div>
  )
}
