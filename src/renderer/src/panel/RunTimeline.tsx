import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentEvent } from '@shared/schema/events'
import type { TaskBoardState } from '@shared/schema/tasks'
import {
  inspectTimelineSpan,
  projectRunTimeline,
  type RunTimeline as RunTimelineModel,
  type TimelineLane
} from '@shared/runTimeline'
import type { RunJournalView, VertragusAppApi } from '../../../preload'
import { errorText } from './viewModel'
import {
  spanStyle,
  timelineChapterLabel,
  timelineHeaderStatus,
  timelineOverflowLabel,
  timelineSpanStatusLabel,
  visibleTimelineLanes
} from './archiveViewModel'

interface Props {
  profileId: string
  workspaceId: string
  /** True while this workspace is still on the live rail. */
  live?: boolean
  bridge: VertragusAppApi
}

/**
 * Swimlanes + inspector over one journal. Same projection for a live card and
 * an archive row — `runs:get` reads the file the host is still appending to.
 */
export function RunTimeline({ profileId, workspaceId, live, bridge }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const [view, setView] = useState<RunJournalView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [fetchedAt, setFetchedAt] = useState(0)

  useEffect(() => {
    let alive = true
    bridge.getRun(profileId, workspaceId).then(
      (next) => {
        if (!alive) return
        setView(next)
        setFetchedAt(next.events.reduce((max, event) => (event.ts > max ? event.ts : max), 0))
      },
      (cause) => {
        if (alive) setError(errorText(cause))
      }
    )
    return () => {
      alive = false
    }
  }, [bridge, profileId, workspaceId])

  const timeline = useMemo(
    () =>
      view
        ? projectRunTimeline({
            workspaceId: view.workspaceId,
            meta: view.meta,
            events: view.events,
            tasks: view.tasks,
            now: fetchedAt || undefined
          })
        : null,
    [view, fetchedAt]
  )

  if (error) return <p className="panel-timeline-error">{error}</p>
  if (view === null) return <p className="panel-timeline-note">{t('panel.timelineLoading')}</p>
  if (view.skipped === 'too_large') {
    return <p className="panel-timeline-note">{t('panel.timelineTooLarge')}</p>
  }
  if (!timeline || (timeline.lanes.length === 0 && view.events.length === 0)) {
    return <p className="panel-timeline-note">{t('panel.timelineEmpty')}</p>
  }

  const visible = visibleTimelineLanes(timeline.lanes)
  const overflow = timelineOverflowLabel(t, timeline.lanes.length)
  const selected = selectedId ?? visible[0]?.agentId
  const inspector = selected
    ? inspectTimelineSpan(timeline, view.events, view.tasks, selected)
    : undefined

  return (
    <div className="panel-timeline">
      <p className="panel-timeline-head">
        <span>{timelineHeaderStatus(t, timeline, Boolean(live))}</span>
        {timeline.pullRequestUrl ? (
          <a href={timeline.pullRequestUrl} target="_blank" rel="noreferrer">
            {t('panel.archivePr')}
          </a>
        ) : (
          <span>{t('panel.timelineNoPr')}</span>
        )}
      </p>
      {timeline.verdict ? <p className="panel-timeline-verdict">{timeline.verdict}</p> : null}
      {timeline.chapters.length > 0 ? (
        <p className="panel-timeline-chapters">
          {timeline.chapters.map((chapter) => (
            <span key={chapter.id}>{timelineChapterLabel(t, chapter.id)}</span>
          ))}
        </p>
      ) : null}
      <ul className="panel-timeline-lanes">
        {visible.map((lane) => (
          <LaneRow
            key={lane.agentId}
            lane={lane}
            timeline={timeline}
            selected={lane.agentId === selected}
            onSelect={() => setSelectedId(lane.agentId)}
          />
        ))}
        {overflow ? (
          <li className="panel-timeline-more" title={overflow}>
            {overflow}
          </li>
        ) : null}
      </ul>
      {inspector ? (
        <Inspector
          name={inspector.span.name}
          roleId={inspector.span.roleId}
          parentName={inspector.parentName}
          status={timelineSpanStatusLabel(t, inspector.span.status)}
          summary={inspector.span.summary}
          hostFacts={inspector.span.hostFacts}
          children={inspector.children}
          events={inspector.events}
          tasks={inspector.tasks}
        />
      ) : (
        <p className="panel-timeline-note">{t('panel.timelineInspectorEmpty')}</p>
      )}
    </div>
  )
}

function LaneRow({
  lane,
  timeline,
  selected,
  onSelect
}: {
  lane: TimelineLane
  timeline: RunTimelineModel
  selected: boolean
  onSelect(): void
}): React.JSX.Element {
  const end = lane.span.endedAt ?? timeline.t1
  const bar = spanStyle(lane.span.startedAt, end, timeline.t0, timeline.t1)
  return (
    <li className={selected ? 'panel-timeline-lane is-selected' : 'panel-timeline-lane'}>
      <button
        type="button"
        className="panel-timeline-lane-btn"
        style={{ paddingLeft: 4 + lane.depth * 8 }}
        onClick={onSelect}
      >
        <span className="panel-timeline-lane-name" title={lane.span.taskSubject ?? lane.roleId}>
          {lane.name}
        </span>
        <span className="panel-timeline-track">
          <span
            className="panel-timeline-span"
            style={{
              left: bar.left,
              width: bar.width,
              background: lane.roleColor
            }}
          />
        </span>
      </button>
    </li>
  )
}

function Inspector({
  name,
  roleId,
  parentName,
  status,
  summary,
  hostFacts,
  children,
  events,
  tasks
}: {
  name: string
  roleId: string
  parentName?: string
  status: string
  summary?: string
  hostFacts?: { branch?: string; diffStat?: string; changedFiles?: string[] }
  children: Array<{ agentId: string; name: string; roleId: string; summary?: string }>
  events: AgentEvent[]
  tasks: NonNullable<TaskBoardState['tasks']>
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="panel-timeline-inspector">
      <p className="panel-timeline-id">
        {name}
        <span className="panel-timeline-role">{roleId}</span>
        {parentName ? <span>← {parentName}</span> : null}
        <span>{status}</span>
      </p>
      {summary ? <p className="panel-timeline-summary">{summary}</p> : null}
      {hostFacts?.diffStat || hostFacts?.branch ? (
        <p className="panel-timeline-facts" title={hostFacts.diffStat}>
          {hostFacts.branch}
          {hostFacts.changedFiles?.length
            ? ` · ${hostFacts.changedFiles.slice(0, 4).join(', ')}`
            : null}
        </p>
      ) : null}
      {children.length > 0 ? (
        <ul className="panel-timeline-children">
          {children.map((child) => (
            <li key={child.agentId}>
              {child.name}
              {child.summary ? ` — ${child.summary}` : ''}
            </li>
          ))}
        </ul>
      ) : null}
      {tasks.length > 0 ? (
        <p className="panel-timeline-tasks">
          {t('panel.timelineTasks')}: {tasks.map((task) => task.subject).join(' · ')}
        </p>
      ) : null}
      {events.length > 0 ? (
        <p className="panel-timeline-events">
          {t('panel.timelineEvents')}: {events.map((item) => item.type).join(', ')}
        </p>
      ) : null}
    </div>
  )
}
