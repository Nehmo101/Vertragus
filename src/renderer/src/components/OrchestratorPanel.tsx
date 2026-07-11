import { useEffect, useRef, useState } from 'react'
import { useAppStore, activeProfile } from '@renderer/store/useAppStore'

function useClock(): string {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])
  return now.toTimeString().slice(0, 8)
}

function fmtTime(ts: number): string {
  return new Date(ts).toTimeString().slice(0, 8)
}

export default function OrchestratorPanel(): JSX.Element {
  const store = useAppStore()
  const clock = useClock()
  const profile = activeProfile(store)
  const orch = store.agents.find((a) => a.kind === 'orchestrator')
  const logRef = useRef<HTMLDivElement>(null)

  const [autoDispatch, setAutoDispatch] = useState(true)

  // Auto-scroll dispatch log to bottom on new events.
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [store.events.length])

  return (
    <section className="orch-panel">
      <div className="orch-head">
        <div className="orch-head-row">
          <span className="orch-diamond">◇</span>
          <span className="orch-title">Orchestrator</span>
          <span className="orch-model">
            {orch?.model ?? profile?.orchestrator?.model ?? '—'}
          </span>
          <div className="spacer" />
          <span className="mini-toggle-label">Auto-Dispatch</span>
          <button
            className={`mini-toggle ${autoDispatch ? '' : 'off'}`}
            title="Automatisches Verteilen an Subagents (Engine folgt in Phase 2)"
            onClick={() => setAutoDispatch((v) => !v)}
          >
            <span className="knob" />
          </button>
        </div>

        <div className="goal-card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span className="goal-caption">Aktuelles Ziel</span>
            <span className="goal-id">{orch ? orch.id : '—'}</span>
          </div>
          {orch ? (
            <>
              <div className="goal-title">Orchestrator läuft interaktiv</div>
              <div className="goal-note">
                Ziel &amp; Subtasks direkt im Orchestrator-Terminal vergeben. Automatische
                Zerlegung + Dispatch an Subagents kommt in Phase 2 (MCP-Engine).
              </div>
            </>
          ) : (
            <>
              <div className="goal-title">Kein aktives Ziel</div>
              <div className="goal-note">
                Workspace starten, um den Orchestrator ({profile?.orchestrator?.provider ?? '—'}/
                {profile?.orchestrator?.model ?? '—'}) zu aktivieren.
              </div>
            </>
          )}
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div className="dag-caption">
          <span>Aufgaben-Zerlegung</span>
          <span className="tag">DAG</span>
        </div>
        <div className="dag-scroll">
          <div className="dag-empty">
            Noch keine automatische Zerlegung — die Orchestrator-Engine (Task-DAG,
            dispatch_subagent, open_subwindow) folgt in Phase 2. Das Dispatch-Protokoll unten
            zeigt bereits echte Agent-Ereignisse.
          </div>
        </div>

        <div className="dispatch">
          <div className="dispatch-head">
            <span className="caption">Dispatch-Protokoll</span>
            <span className="dot" />
            <div className="spacer" />
            <span className="clock">{clock}</span>
          </div>
          <div className="dispatch-body" ref={logRef}>
            {store.events.length === 0 && (
              <div className="dispatch-line tone-muted">— bereit —</div>
            )}
            {store.events.map((evt, i) => (
              <div key={i} className={`dispatch-line tone-${evt.tone}`}>
                <span className="time">{fmtTime(evt.time)}</span> {evt.text}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
