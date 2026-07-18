import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { OrchestratorSnapshot } from '@shared/orchestrator'
import { messagesForThread, useCanvasChatStore, type CanvasChatMessage } from '../store/canvasChatStore'
import { OrchestratorActivityRow, type OrchestratorThreadRowTone } from './orchestratorActivityRow'

export interface SnapshotThreadEntry {
  id: string
  tone: OrchestratorThreadRowTone
  title: string
  detail?: string
  timestamp: number
  message?: CanvasChatMessage
}

export function snapshotThreadEntries(snapshot: OrchestratorSnapshot): SnapshotThreadEntry[] {
  const entries: SnapshotThreadEntry[] = []
  if (snapshot.goal) {
    entries.push({ id: `goal-${snapshot.goal.id}`, tone: 'goal', title: snapshot.goal.title, detail: snapshot.goal.active ? 'active' : 'waiting', timestamp: 0 })
  }
  if (snapshot.activity) {
    entries.push({ id: `activity-${snapshot.activity.updatedAt}`, tone: 'activity', title: snapshot.activity.summary, detail: snapshot.activity.details.join(' · '), timestamp: snapshot.activity.updatedAt })
  }
  for (const task of snapshot.tasks) {
    entries.push({
      id: `task-${task.id}-${task.phase ?? task.status}`,
      tone: 'task',
      title: task.title,
      detail: [task.phase ?? task.status, task.lastAction].filter(Boolean).join(' · '),
      timestamp: task.lastHeartbeatAt ?? task.finishedAt ?? task.createdAt
    })
  }
  for (const finding of snapshot.findings ?? []) {
    entries.push({ id: `finding-${finding.id}`, tone: 'finding', title: finding.title, detail: finding.detail, timestamp: finding.createdAt })
  }
  return entries.sort((a, b) => a.timestamp - b.timestamp)
}

export interface OrchestratorThreadProps {
  profileId: string
  workspaceSessionId?: string
  snapshot: OrchestratorSnapshot
  reviewPendingPlan(approved: boolean): Promise<void>
  defaultOpen?: boolean
}

export function OrchestratorThread({
  profileId,
  workspaceSessionId,
  snapshot,
  reviewPendingPlan,
  defaultOpen = false
}: OrchestratorThreadProps): JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(defaultOpen)
  const messages = useCanvasChatStore((state) => state.messages)
  const rows = useMemo(() => {
    const own = messagesForThread(messages, profileId, workspaceSessionId).map((message) => ({
      id: message.id,
      tone: 'user' as const,
      title: message.text,
      detail: t(`canvas.thread.message.${message.status}`),
      timestamp: message.createdAt,
      message
    }))
    return [...snapshotThreadEntries(snapshot), ...own].sort((a, b) => a.timestamp - b.timestamp)
  }, [messages, profileId, snapshot, t, workspaceSessionId])

  return (
    <section className={`orchestrator-thread${open ? ' is-open' : ''}`} aria-label={t('canvas.thread.label')}>
      <button type="button" className="orchestrator-thread-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span>{t('canvas.thread.title')}</span>
        {!open && snapshot.activity ? <span className="orchestrator-thread-latest">{snapshot.activity.summary}</span> : null}
        {!open && rows.length > 0 ? <span className="orchestrator-thread-unread" aria-label={t('canvas.thread.unread')} /> : null}
      </button>
      {open ? (
        <div className="orchestrator-thread-feed" role="log" aria-live="polite">
          {rows.length === 0 && !snapshot.pendingPlan ? <p className="orchestrator-thread-empty">{t('canvas.thread.empty')}</p> : null}
          {rows.map((row) => <OrchestratorActivityRow key={row.id} tone={row.tone} title={row.title} detail={row.detail} timestamp={row.timestamp || undefined} />)}
          {snapshot.pendingPlan ? (
            <OrchestratorActivityRow tone="plan" title={t('canvas.thread.plan.title')} detail={t('canvas.thread.plan.stats', { count: snapshot.pendingPlan.plan.tasks.length })}>
              <ol>{snapshot.pendingPlan.plan.tasks.map((task) => <li key={task.id}><strong>{task.title}</strong><span>{task.role}</span></li>)}</ol>
              <div className="orchestrator-thread-plan-actions">
                <button type="button" onClick={() => void reviewPendingPlan(false)}>{t('canvas.thread.plan.reject')}</button>
                <button type="button" className="primary" onClick={() => void reviewPendingPlan(true)}>{t('canvas.thread.plan.approve')}</button>
              </div>
            </OrchestratorActivityRow>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
