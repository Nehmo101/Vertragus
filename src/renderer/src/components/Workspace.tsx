import { useTranslation } from 'react-i18next'
import { useEffect, useState } from 'react'
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
import Spinner from '@renderer/components/ui/Spinner'
import { useLayoutStore } from '@renderer/store/layoutStore'
import styles from './responsiveGuards.module.css'

/** After this many ms the workspace renders normally even if init() never finished. */
const BOOTSTRAP_TIMEOUT_MS = 10_000

// '◈' statt '⌘': das Befehlssymbol kollidiert auf dem Mac mit der Cmd-Taste.
const LAYOUTS: Array<{ id: WorkspaceLayout; icon: string; fallback: string }> = [
  { id: 'canvas', icon: '◈', fallback: 'Zentrale' },
  { id: 'tiles', icon: '▦', fallback: 'Terminals' },
  { id: 'focus', icon: '▣', fallback: 'Fokus' }
]

export default function Workspace(): JSX.Element {
  const { t } = useTranslation()
  const bootstrapped = useAppStore((state) => state.bootstrapped)
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
  const canvasAutoCollapseDone = useLayoutStore((state) => state.canvasAutoCollapseDone)
  const markCanvasAutoCollapseDone = useLayoutStore((state) => state.markCanvasAutoCollapseDone)
  // Auto-collapse der Sidebar nur beim allerersten Canvas-Besuch; danach
  // bleibt die Nutzerwahl erhalten (persistenter Flag im layoutStore).
  useEffect(() => {
    if (workspaceLayout === 'canvas' && !canvasAutoCollapseDone) {
      collapseSidebar('sidebar-left', true)
      markCanvasAutoCollapseDone()
    }
  }, [workspaceLayout, canvasAutoCollapseDone, collapseSidebar, markCanvasAutoCollapseDone])

  // App-start loading state: while the one-time store bootstrap runs, showing
  // "0 agents" plus the empty hero would be misleading. Show a centered
  // spinner instead — with a hard timeout so a stuck init() never blocks the
  // workspace forever.
  const [bootstrapTimedOut, setBootstrapTimedOut] = useState(false)
  useEffect(() => {
    if (bootstrapped) return
    const timer = setTimeout(() => setBootstrapTimedOut(true), BOOTSTRAP_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [bootstrapped])

  if (!bootstrapped && !bootstrapTimedOut) {
    return (
      <main
        className={`workspace ${styles.workspace} workspace-${workspaceLayout}`}
        aria-label={t('workspace.aria')}
      >
        <div
          className="ws-scroll"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <div
            role="status"
            style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-2)', fontSize: 14 }}
          >
            {/* i18n-spaeter: umlautfreier Text, bis die i18n-Welle ihn in die locales hebt. */}
            <Spinner /> Lade Workspace…
          </div>
        </div>
      </main>
    )
  }

  return (
    <main
      className={`workspace ${styles.workspace} workspace-${workspaceLayout}`}
      aria-label={t('workspace.aria')}
    >
      <div className="ws-header">
        {workspaceLayout === 'canvas' && (
          <button type="button" className="clean-btn canvas-orch-toggle" data-open={orchDrawerOpen} aria-pressed={orchDrawerOpen} onClick={toggleOrchDrawer}>
            {/* Lore-Name aus dem i18n-Key + statischer Funktions-Zusatz,
                damit klar ist, was sich hinter „Caronte" verbirgt. */}
            {t('canvas.orchestratorToggle', { defaultValue: 'Caronte' })}
            <span className="canvas-orch-toggle-role"> · Orchestrator</span>
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
              <span className="layout-btn-label">
                {t(`canvas.layout.${layout.id}`, { defaultValue: layout.fallback })}
              </span>
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
                  void window.vertragus.demo.play()
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
