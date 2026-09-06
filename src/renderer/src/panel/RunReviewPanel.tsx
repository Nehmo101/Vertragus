import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { RunReview } from '@shared/runReview'
import type { VertragusAppApi, WorkspaceAgentSummary } from '../../../preload'
import { followHostChanges } from '../lib/hostInvalidation'
import { useSubmission } from '../lib/useDraft'

/** Git facts, human promotion, recovery and durable finalization share the host APIs. */
export function RunReviewPanel({ profileId, workspaceId, bridge, live = false, agents = [] }: {
  profileId: string
  workspaceId: string
  bridge: VertragusAppApi
  live?: boolean
  agents?: readonly WorkspaceAgentSummary[]
}): React.JSX.Element {
  const { t } = useTranslation()
  const finalizationLabels = { pending: t('review.finalization.pending'), running: t('review.finalization.running'), failed: t('review.finalization.failed'), completed: t('review.finalization.completed') }
  const [review, setReview] = useState<RunReview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState('')
  const action = useSubmission()
  useEffect(() => {
    let alive = true
    let revision = 0
    const refresh = (): void => {
      const request = ++revision
      bridge.getRunReview(profileId, workspaceId).then((next) => {
        if (!alive || request !== revision) return
        setReview(next); setError(null)
        setSelected((current) => next.branches.some((branch) => branch.branch === current) ? current : next.branches.find((branch) => branch.root)?.branch ?? next.branches[0]?.branch ?? '')
      }, (cause: unknown) => { if (alive && request === revision) setError(cause instanceof Error ? cause.message : String(cause)) })
    }
    refresh()
    const off = followHostChanges(bridge, refresh)
    return () => { alive = false; off() }
  }, [bridge, profileId, workspaceId])
  const branch = review?.branches.find((entry) => entry.branch === selected)
  const reports = review?.events.filter((event) => event.type === 'agent_done' && event.branch === selected) ?? []
  const integrations = review?.events.filter((event) => (event.type === 'integrate_ok' || event.type === 'integrate_conflict') && event.branch === selected) ?? []
  const agentEvent = review?.events.find((event) => event.type === 'agent_started' && event.branch === selected)
  const agent = agentEvent && 'agentId' in agentEvent ? agents.find((entry) => entry.agentId === agentEvent.agentId) : undefined
  const tasks = review?.tasks?.tasks.filter((task) => task.status !== 'completed') ?? []
  return <section className="panel-review">
    <h3 className="panel-label">{t('review.title')}</h3>
    {review ? <>
      <select className="panel-answer-input" aria-label={t('review.branch')} value={selected} onChange={(event) => setSelected(event.target.value)}>
        {review.branches.map((entry) => <option key={entry.branch} value={entry.branch}>{entry.branch}{entry.root ? ` · ${t('review.root')}` : ''}</option>)}
      </select>
      {branch ? <>
        <dl className="panel-review-facts">
          <dt>{t('review.head')}</dt><dd><code>{branch.head ?? t('review.unknown')}</code></dd>
          <dt>{t('review.worktree')}</dt><dd>{branch.path}</dd>
          <dt>{t('review.changes')}</dt><dd>{branch.dirty === undefined ? t('review.unknown') : branch.dirty ? t('review.dirty') : t('review.clean')}</dd>
          <dt>{t('review.ahead')}</dt><dd>{branch.ahead ?? t('review.unknown')}</dd>
        </dl>
        {branch.changedFiles?.length ? <details><summary>{t('review.files', { count: branch.changedFiles.length })}</summary><ul>{branch.changedFiles.map((file) => <li key={file}>{file}</li>)}</ul></details> : null}
      </> : <p>{t('review.noBranches')}</p>}
      {reports.map((event) => event.type === 'agent_done' ? <details key={event.seq}>
        <summary>{t('review.report', { name: event.name, status: event.status })}</summary>
        <p>{event.summary}</p><code>{event.headSha}</code>
        {event.snapshotError ? <p className="panel-retro-error">{event.snapshotError}</p> : null}
      </details> : null)}
      <p className="panel-retro-note">{t('review.verificationHint')}</p>
      {integrations.map((event) => event.type === 'integrate_ok' ? <p key={event.seq}>{event.target === 'checkout' ? t('review.integratedCheckout') : t('review.integratedWorktree')} <code>{event.headSha}</code></p> : event.type === 'integrate_conflict' ? <p key={event.seq} className="panel-retro-error">{event.message}</p> : null)}
      {agent?.state === 'stopped' ? <button type="button" className="panel-answer-send" disabled={action.busy} onClick={() => void action.run(async () => {
        await bridge.promoteAgentBranch(workspaceId, agent.agentId)
        setReview(await bridge.getRunReview(profileId, workspaceId))
      })}>{t('review.promote')}</button> : null}
      {!live && branch ? <>
        {branch.dirty ? <p className="panel-retro-note">{t('review.resumeDirty')}</p> : null}
        <button type="button" className="panel-answer-send" disabled={action.busy} onClick={() => void action.run(() => bridge.resumeWorkspace(profileId, { workspaceId, baseBranch: branch.branch }))}>{t('review.resume')}</button>
      </> : null}
      {tasks.length ? <details><summary>{t('review.openTasks', { count: tasks.length })}</summary><ul>{tasks.map((task) => <li key={task.taskId}>{task.subject}</li>)}</ul></details> : null}
      {review.finalization ? <div className="panel-finalization">
        <p>{finalizationLabels[review.finalization.status]} · {t('review.attempts', { count: review.finalization.attempts })}</p>
        {review.finalization.error ? <p className="panel-retro-error">{review.finalization.error}</p> : null}
        {review.finalization.url ? <a href={review.finalization.url} target="_blank" rel="noreferrer">{t('panel.pullRequestOpen')}</a> : null}
        {review.finalization.status === 'failed' || review.finalization.status === 'pending' ? <button type="button" className="panel-answer-send" disabled={action.busy} onClick={() => void action.run(async () => {
          await bridge.retryRunFinalization(profileId, workspaceId)
          setReview(await bridge.getRunReview(profileId, workspaceId))
        })}>{t('review.retry')}</button> : null}
      </div> : null}
    </> : <p>{t('common.loading')}</p>}
    {error || action.error ? <p className="panel-retro-error" role="alert">{error ?? action.error}</p> : null}
  </section>
}
