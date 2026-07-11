import { useAppStore, activeProfile } from '@renderer/store/useAppStore'
import AgentPane from '@renderer/components/AgentPane'

export default function Workspace(): JSX.Element {
  const store = useAppStore()
  const profile = activeProfile(store)
  const agents = store.agents
  const cols = agents.length + 1 > 5 ? 3 : 2

  return (
    <main className="workspace">
      <div className="ws-header">
        <span className="crumb-root">Workspace</span>
        <span className="crumb-sep">/</span>
        <span className="crumb">{profile?.name ?? '—'}</span>
        <div className="spacer" />
        <span className="ws-count">
          {agents.length} Agents · Kachel-Layout
        </span>
        {agents.length > 0 && (
          <>
            <div className="ws-divider" />
            <button
              className="clean-btn"
              title="Workspace leeren: alle Agents stoppen und entfernen"
              onClick={() => void store.cleanWorkspace()}
            >
              🧹 Leeren
            </button>
          </>
        )}
        <div className="ws-divider" />
        <button className="layout-btn active" title="Kachel-Layout">
          ▦
        </button>
        <button
          className="layout-btn"
          title="Fokus-Layout (Phase 2)"
          onClick={() => store.showToast('Fokus-Layout kommt in Phase 2.')}
        >
          ▭
        </button>
      </div>

      <div className="ws-scroll">
        <div className={`ws-grid cols-${cols}`}>
          {agents.length === 0 && (
            <div className="ws-empty">
              <div className="big">Keine Agents aktiv</div>
              <div>
                „▶ Alle starten" startet das Profil{' '}
                <b style={{ color: 'var(--text-2)' }}>{profile?.name ?? '—'}</b> — oder unten
                einen einzelnen Agent hinzufügen.
              </div>
            </div>
          )}
          {agents.map((agent) => (
            <AgentPane
              key={agent.id}
              agent={agent}
              onClose={() => void store.killAgent(agent.id)}
              onPopout={() => void store.popout(agent.id)}
            />
          ))}
          <button className="add-tile" onClick={() => void store.addAgent()}>
            <span className="plus">＋</span>
            <span className="t1">Agent hinzufügen</span>
            <span className="t2">Provider &amp; Modell wählen</span>
          </button>
        </div>
      </div>
    </main>
  )
}
