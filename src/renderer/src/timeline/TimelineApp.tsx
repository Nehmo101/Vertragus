import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentEvent } from '@shared/schema/events'
import type { VertragusAppApi, WorkspaceSummary } from '../../../preload'
import { activeLocale } from '../i18n'
import { errorText } from '../panel/viewModel'
import { CloseIcon } from '../panel/icons'
import { WorkspaceCard } from '../panel/WorkspaceCard'
import { formatEvent, formatEventTime, mergeEvents } from './formatEvent'
import '../panel/panel.css'
import './timeline.css'

/**
 * Glass overview for one workspace: the same card the panel paints (agents,
 * task board, goal) plus the chronological journal. Live agents/tasks ride
 * `ev:workspaces`; events ride `timeline:attach` + `ev:timeline` — this
 * window never reads `events.jsonl`.
 */
export function TimelineApp({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const bridge = useMemo(() => window.vertragus?.app, [])
  const [workspace, setWorkspace] = useState<WorkspaceSummary | null>(null)
  const [events, setEvents] = useState<AgentEvent[]>([])
  const [error, setError] = useState<string | null>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const fail = useCallback((cause: unknown) => setError(errorText(cause)), [])
  const run = useCallback(
    (action: (api: VertragusAppApi) => Promise<unknown>) => {
      if (!bridge) return
      setError(null)
      action(bridge).catch(fail)
    },
    [bridge, fail]
  )

  useEffect(() => {
    if (!bridge) return
    let alive = true
    const pick = (list: WorkspaceSummary[]): void => {
      if (!alive) return
      setWorkspace(list.find((entry) => entry.workspaceId === workspaceId) ?? null)
    }
    bridge.listWorkspaces().then(pick, fail)
    const offWorkspaces = bridge.onWorkspaces(pick)
    const offTimeline = bridge.onTimelineEvent((event) => {
      setEvents((current) => mergeEvents(current, [event]))
    })
    bridge.attachTimeline().then((snapshot) => {
      if (alive) setEvents((current) => mergeEvents(snapshot.events, current))
    }, fail)
    return () => {
      alive = false
      offWorkspaces()
      offTimeline()
    }
  }, [bridge, fail, workspaceId])

  useEffect(() => {
    const node = listRef.current
    if (!node) return
    node.scrollTop = node.scrollHeight
  }, [events.length])

  const locale = activeLocale(i18n.language)
  const rows = events.map((event) => formatEvent(t, event, locale))

  return (
    <div className="tl glass">
      <header className="tl-head">
        <h1 className="tl-title">{t('timeline.title')}</h1>
        <span className="tl-subtitle">{workspace?.name ?? workspaceId}</span>
        <button
          type="button"
          className="tl-close"
          title={t('timeline.close')}
          aria-label={t('timeline.close')}
          onClick={() => bridge?.closeTimeline()}
        >
          <CloseIcon size={11} />
        </button>
      </header>

      <div className="tl-body">
        {!bridge ? <p className="tl-fatal">{t('common.bridgeMissing')}</p> : null}
        {error ? (
          <button type="button" className="panel-error is-clickable" onClick={() => setError(null)}>
            {error}
          </button>
        ) : null}
        {workspace ? (
          <div className="tl-card">
            <WorkspaceCard
              workspace={workspace}
              expanded
              showUsage
              onToggle={() => undefined}
              onStop={(id) => run((api) => api.stopWorkspace(id))}
              onSucceedOrchestrator={(id) => run((api) => api.succeedOrchestrator(id))}
              onFocusAgent={(agentId) => run((api) => api.focusAgent(agentId))}
              onCloseAgentWindow={(agentId) => run((api) => api.closeAgentWindow(agentId))}
              onAssignGoal={(id, goal) => run((api) => api.assignWorkspaceGoal(id, goal))}
              onAnswerQuestion={(id, agentId, questionId, text) =>
                run((api) => api.answerQuestion(id, agentId, questionId, text))
              }
              onUserMessage={(id, text, targetAgentId) =>
                run((api) => api.sendUserMessage(id, text, targetAgentId))
              }
              onPromoteAgent={(id, agentId) => run((api) => api.promoteAgentBranch(id, agentId))}
              onOpenRunFolder={(id) => run((api) => api.openRunFolder(id))}
            />
          </div>
        ) : bridge ? (
          <p className="tl-empty">{t('common.loading')}</p>
        ) : null}

        <section className="tl-events">
          <h2 className="tl-events-label">{t('timeline.eventsLabel')}</h2>
          {rows.length === 0 ? (
            <p className="tl-empty">{t('timeline.eventsEmpty')}</p>
          ) : (
            <ul className="tl-events-list" ref={listRef}>
              {rows.map((row) => (
                <li key={row.seq} className="tl-event">
                  <span className="tl-event-time">{formatEventTime(row.ts, locale)}</span>
                  <span className="tl-event-label">{row.label}</span>
                  {row.detail ? <p className="tl-event-detail">{row.detail}</p> : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
