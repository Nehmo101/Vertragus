import {
  useAppStore,
  activeProfile,
  workspaceAgents,
  type WorkspaceLayout
} from '@renderer/store/useAppStore'
import AgentPane from '@renderer/components/AgentPane'
import VoiceBar from '@renderer/components/VoiceBar'

const LAYOUTS: Array<{ id: WorkspaceLayout; icon: string; label: string }> = [
  { id: 'tiles', icon: '▦', label: 'Kacheln' },
  { id: 'focus', icon: '▭', label: 'Fokus' },
  { id: 'dag', icon: '◇', label: 'DAG' }
]

export default function Workspace(): JSX.Element {
  const store = useAppStore()
  const profile = activeProfile(store)
  const agents = [...workspaceAgents(store)].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'orchestrator' ? -1 : 1
    return a.startedAt - b.startedAt
  })
  const activeRunning = agents.some(
    (agent) => agent.status === 'running' || agent.status === 'waiting'
  )
  const focusedId = agents.some((agent) => agent.id === store.selectedAgentId)
    ? store.selectedAgentId
    : (agents[0]?.id ?? null)
  const selectedAgent = agents.find((agent) => agent.id === focusedId)
  const cols = agents.length + 1 > 5 ? 3 : 2


  return (
    <main className={`workspace workspace-${store.workspaceLayout}`} aria-label="Agent-Workspace">
      <div className="ws-header">
        <label className="workspace-picker">
          <span>Workspace</span>
          <select
            value={store.activeProfileId}
            onChange={(event) => void store.selectProfile(event.target.value)}
            aria-label="Aktives Workspace-Profil wählen"
          >
            {store.profiles.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} — {item.workingDir || 'kein Ordner'}
              </option>
            ))}
          </select>
        </label>
        <div className="workspace-context" aria-label="Workspace-Kontext">
          {store.gitInfo?.isRepo && (
            <span
              className={`workspace-context-chip ${store.gitInfo.dirty ? 'dirty' : ''}`}
              title={store.gitInfo.root}
            >
              Branch: {store.gitInfo.branch ?? 'unbekannt'}
            </span>
          )}
          {profile?.githubProject && (
            <span className="workspace-context-chip board" title={profile.githubProject.url}>
              Board: {profile.githubProject.title} · #{profile.githubProject.number}
            </span>
          )}
        </div>
        <div className="spacer" />
        <span className="ws-count">
          {agents.length} Agents · {LAYOUTS.find((item) => item.id === store.workspaceLayout)?.label}
        </span>
        {!activeRunning && (
          <button
            type="button"
            className="clean-btn workspace-start-btn"
            onClick={() => void store.startAll()}
          >
            Workspace starten
          </button>
        )}
        {agents.length > 0 && (
          <>
            <div className="ws-divider" />
            <button
              type="button"
              className="clean-btn"
              title="Workspace leeren: alle Agents stoppen und entfernen"
              onClick={() => void store.cleanWorkspace()}
            >
              🧹 Leeren
            </button>
          </>
        )}
        <div className="ws-divider" />
        <div className="layout-switch" role="group" aria-label="Workspace-Layout">
          {LAYOUTS.map((layout) => (
            <button
              key={layout.id}
              type="button"
              className={`layout-btn ${store.workspaceLayout === layout.id ? 'active' : ''}`}
              title={`${layout.label}-Layout`}
              aria-label={`${layout.label}-Layout aktivieren`}
              aria-pressed={store.workspaceLayout === layout.id}
              onClick={() => store.setWorkspaceLayout(layout.id)}
            >
              {layout.icon}
            </button>
          ))}
        </div>
      </div>

      <VoiceBar key={selectedAgent?.id ?? 'no-agent'} agent={selectedAgent} />
      <div className="ws-scroll">
        {store.workspaceLayout === 'dag' && (
          <div className="dag-layout-note">
            <b>Planungsansicht</b>
            <span>Der Aufgaben-DAG ist vergrößert; Terminals bleiben rechts interaktiv.</span>
          </div>
        )}
        <div className={`ws-grid cols-${cols}`}>
          {agents.length === 0 && (
            <div className="ws-empty">
              <div className="big">Keine Agents aktiv</div>
              <div>
                „▶ Alle starten“ startet das Profil{' '}
                <b style={{ color: 'var(--text-2)' }}>{profile?.name ?? '—'}</b> — oder unten
                einen einzelnen Agent hinzufügen.
              </div>
            </div>
          )}
          {agents.map((agent) => (
            <AgentPane
              key={agent.id}
              agent={agent}
              focused={store.workspaceLayout === 'focus' && agent.id === focusedId}
              subdued={store.workspaceLayout === 'focus' && agent.id !== focusedId}
              onFocus={() => store.setSelectedAgent(agent.id)}
              onClose={() => void store.killAgent(agent.id)}
              onPopout={() => void store.popout(agent.id)}
              onHandoff={() => store.openHandoff(agent.id)}
            />
          ))}
          <button type="button" className="add-tile" onClick={() => void store.addAgent()}>
            <span className="plus">＋</span>
            <span className="t1">Agent hinzufügen</span>
            <span className="t2">Provider &amp; Modell wählen</span>
          </button>
        </div>
      </div>
    </main>
  )
}
