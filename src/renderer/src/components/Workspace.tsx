import {
  useAppStore,
  activeProfile,
  isFinishedSubagent,
  visibleWorkspaceAgents,
  workspaceAgents,
  type WorkspaceLayout
} from '@renderer/store/useAppStore'
import AgentPane from '@renderer/components/AgentPane'
import CanvasBoard from '@renderer/components/CanvasBoard'
import VoiceBar from '@renderer/components/VoiceBar'
import styles from './responsiveGuards.module.css'

const LAYOUTS: Array<{ id: WorkspaceLayout; icon: string; label: string }> = [
  { id: 'tiles', icon: '▦', label: 'Kacheln' },
  { id: 'focus', icon: '▭', label: 'Fokus' },
  { id: 'canvas', icon: '✦', label: 'Canvas' }
]

export default function Workspace(): JSX.Element {
  const profiles = useAppStore((state) => state.profiles)
  const activeProfileId = useAppStore((state) => state.activeProfileId)
  const activeWorkspaceSessionId = useAppStore((state) => state.activeWorkspaceSessionId)
  const gitInfo = useAppStore((state) => state.gitInfo)
  const agents = useAppStore((state) => state.agents)
  const reopenedAgentIds = useAppStore((state) => state.reopenedAgentIds)
  const selectedAgentId = useAppStore((state) => state.selectedAgentId)
  const workspaceLayout = useAppStore((state) => state.workspaceLayout)
  const actions = useAppStore.getState()
  const profile = activeProfile({ profiles, activeProfileId })
  const allAgents = workspaceAgents({ agents, activeProfileId, activeWorkspaceSessionId })
  const sortedAgents = [...visibleWorkspaceAgents({
    agents,
    activeProfileId,
    activeWorkspaceSessionId,
    reopenedAgentIds
  })].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'orchestrator' ? -1 : 1
    return a.startedAt - b.startedAt
  })
  const activeRunning = allAgents.some(
    (agent) => agent.status === 'running' || agent.status === 'waiting'
  )
  const focusedId = sortedAgents.some((agent) => agent.id === selectedAgentId)
    ? selectedAgentId
    : (sortedAgents[0]?.id ?? null)
  const selectedAgent = sortedAgents.find((agent) => agent.id === focusedId)

  return (
    <main className={`workspace ${styles.workspace} workspace-${workspaceLayout}`} aria-label="Agent-Workspace">
      <div className="ws-header">
        <label className="workspace-picker">
          <span>Workspace</span>
          <select
            value={activeProfileId}
            onChange={(event) => void actions.selectProfile(event.target.value)}
            aria-label="Aktives Workspace-Profil wählen"
          >
            {profiles.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} — {item.workingDir || 'kein Ordner'}
              </option>
            ))}
          </select>
        </label>
        <div className="workspace-context" aria-label="Workspace-Kontext">
          {gitInfo?.isRepo && (
            <span
              className={`workspace-context-chip ${gitInfo.dirty ? 'dirty' : ''}`}
              title={gitInfo.root}
            >
              Branch: {gitInfo.branch ?? 'unbekannt'}
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
          {allAgents.length} Agents · {LAYOUTS.find((item) => item.id === workspaceLayout)?.label}
        </span>
        {!activeRunning && (
          <button
            type="button"
            className="clean-btn workspace-start-btn"
            onClick={() => void actions.startAll()}
          >
            Workspace starten
          </button>
        )}
        {allAgents.length > 0 && (
          <>
            <div className="ws-divider" />
            <button
              type="button"
              className="clean-btn"
              title="Workspace leeren: alle Agents stoppen und entfernen"
              onClick={() => void actions.cleanWorkspace()}
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
              className={`layout-btn ${workspaceLayout === layout.id ? 'active' : ''}`}
              title={`${layout.label}-Layout`}
              aria-label={`${layout.label}-Layout aktivieren`}
              aria-pressed={workspaceLayout === layout.id}
              onClick={() => actions.setWorkspaceLayout(layout.id)}
            >
              {layout.icon}
            </button>
          ))}
        </div>
      </div>

      <VoiceBar key={selectedAgent?.id ?? 'no-agent'} agent={selectedAgent} />
      <div className="ws-scroll">
        {workspaceLayout === 'canvas' ? (
          <CanvasBoard />
        ) : (
        <div className="ws-grid">
          {sortedAgents.length === 0 && (
            <div className="ws-empty">
              <div className="big">Keine Agents aktiv</div>
              <div>
                „▶ Alle starten“ startet das Profil{' '}
                <b style={{ color: 'var(--text-2)' }}>{profile?.name ?? '—'}</b> — oder unten
                einen einzelnen Agent hinzufügen.
              </div>
            </div>
          )}
          {sortedAgents.map((agent) => (
            <AgentPane
              key={agent.id}
              agent={agent}
              focused={workspaceLayout === 'focus' && agent.id === focusedId}
              subdued={workspaceLayout === 'focus' && agent.id !== focusedId}
              onFocus={() => actions.setSelectedAgent(agent.id)}
              onClose={() => {
                if (isFinishedSubagent(agent)) actions.hideAgent(agent.id)
                else void actions.killAgent(agent.id)
              }}
              onPopout={() => void actions.popout(agent.id)}
              onHandoff={() => actions.openHandoff(agent.id)}
            />
          ))}
          <button type="button" className="add-tile" onClick={() => actions.openAddAgent()}>
            <span className="plus">＋</span>
            <span className="t1">Agent hinzufügen</span>
            <span className="t2">Provider &amp; Modell wählen</span>
          </button>
        </div>
        )}
      </div>
    </main>
  )
}
