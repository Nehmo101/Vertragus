import { useTranslation } from 'react-i18next'
import { useEffect } from 'react'
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
import { useLayoutStore } from '@renderer/store/layoutStore'
import styles from './responsiveGuards.module.css'

const LAYOUTS: Array<{ id: WorkspaceLayout; icon: string; fallback: string }> = [
  { id: 'canvas', icon: '⌘', fallback: 'Zentrale' },
  { id: 'tiles', icon: '▦', fallback: 'Terminals' },
  { id: 'focus', icon: '▣', fallback: 'Fokus' }
]

export default function Workspace(): JSX.Element {
  const { t } = useTranslation()
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
  const layoutLabel = (id: WorkspaceLayout): string => t(`workspace.layouts.${id}`)
  const collapseSidebar = useLayoutStore((state) => state.collapse)
  const orchDrawerOpen = useLayoutStore((state) => state.orchDrawerOpen)
  const toggleOrchDrawer = useLayoutStore((state) => state.toggleOrchDrawer)
  useEffect(() => {
    if (workspaceLayout === 'canvas') collapseSidebar('sidebar-left', true)
  }, [workspaceLayout, collapseSidebar])

  return (
    <main
      className={`workspace ${styles.workspace} workspace-${workspaceLayout}`}
      aria-label={t('workspace.aria')}
    >
      <div className="ws-header">
        {workspaceLayout === 'canvas' && (
          <button type="button" className="clean-btn canvas-orch-toggle" data-open={orchDrawerOpen} aria-pressed={orchDrawerOpen} onClick={toggleOrchDrawer}>
            {t('canvas.orchestratorToggle', { defaultValue: 'Caronte' })}
          </button>
        )}
        <label className="workspace-picker">
          <span>{t('workspace.picker')}</span>
          <select
            value={activeProfileId}
            onChange={(event) => void actions.selectProfile(event.target.value)}
            aria-label={t('workspace.pickProfile')}
          >
            {profiles.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} — {item.workingDir || t('workspace.noFolder')}
              </option>
            ))}
          </select>
        </label>
        <div className="workspace-context" aria-label={t('workspace.context')}>
          {gitInfo?.isRepo && (
            <span
              className={`workspace-context-chip ${gitInfo.dirty ? 'dirty' : ''}`}
              title={gitInfo.root}
            >
              {t('workspace.branch')}: {gitInfo.branch ?? t('workspace.unknown')}
            </span>
          )}
          {profile?.githubProject && (
            <span className="workspace-context-chip board" title={profile.githubProject.url}>
              {t('workspace.board')}: {profile.githubProject.title} · #{profile.githubProject.number}
            </span>
          )}
        </div>
        <div className="spacer" />
        <span className="ws-count">
          {allAgents.length} {t('workspace.agents')} · {layoutLabel(workspaceLayout)}
        </span>
        {!activeRunning && (
          <button
            type="button"
            className="clean-btn workspace-start-btn"
            onClick={() => void actions.startAll()}
          >
            {t('workspace.start')}
          </button>
        )}
        {allAgents.length > 0 && (
          <>
            <div className="ws-divider" />
            <button
              type="button"
              className="clean-btn"
              title={t('workspace.cleanTitle')}
              onClick={() => void actions.cleanWorkspace()}
            >
              {t('workspace.clean')}
            </button>
          </>
        )}
        <div className="ws-divider" />
        <div className="layout-switch" role="group" aria-label={t('workspace.layoutGroup')}>
          {LAYOUTS.map((layout) => (
            <button
              key={layout.id}
              type="button"
              className={`layout-btn ${workspaceLayout === layout.id ? 'active' : ''}`}
              title={t('workspace.layoutTitle', { label: layoutLabel(layout.id) })}
              aria-label={t('workspace.layoutActivate', { label: layoutLabel(layout.id) })}
              aria-pressed={workspaceLayout === layout.id}
              onClick={() => actions.setWorkspaceLayout(layout.id)}
            >
              <span aria-hidden="true">{layout.icon}</span>
              <span>{t(`canvas.layout.${layout.id}`, { defaultValue: layout.fallback })}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="ws-scroll">
        {workspaceLayout === 'canvas' ? (
          <CanvasBoard />
        ) : (
        <div className="ws-grid">
          {sortedAgents.length === 0 && (
            <div className="ws-empty">
              <div className="big">{t('workspace.empty')}</div>
              <div>
                {t('workspace.emptyHintLead')}{' '}
                <b style={{ color: 'var(--text-2)' }}>{profile?.name ?? '—'}</b>{' '}
                {t('workspace.emptyHintTail')}
              </div>
              <button
                type="button"
                className="clean-btn ws-playground-btn"
                title={t('workspace.playgroundHint')}
                onClick={() => {
                  actions.setWorkspaceLayout('canvas')
                  void window.orca.demo.play()
                }}
              >
                {t('workspace.playground')}
              </button>
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
            <span className="t1">{t('workspace.addAgent')}</span>
            <span className="t2">{t('workspace.addAgentSub')}</span>
          </button>
        </div>
        )}
      </div>
    </main>
  )
}
