import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { RunListEntry, VertragusAppApi } from '../../../preload'
import { followHostChanges } from '../lib/hostInvalidation'
import { errorText } from './viewModel'
import { archiveDurationLabel, archiveGoalLine, archiveStatusLabel } from './archiveViewModel'
import type { RunSearchResult } from '@shared/runSearch'
import { RunReviewPanel } from './RunReviewPanel'
import { RunTimeline } from './RunTimeline'

interface Props {
  profileId: string
  liveWorkspaceIds: readonly string[]
  bridge: VertragusAppApi
}

/**
 * Fold-out under a profile row: journals Stop left on disk. Same mount/error
 * rules as RetroPanel. Click a row to open the timeline projection.
 */
export function ArchivePanel({ profileId, liveWorkspaceIds, bridge }: Props): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const [rows, setRows] = useState<RunListEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const live = new Set(liveWorkspaceIds)
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [since, setSince] = useState('')
  const [search, setSearch] = useState<{ query: string; result: RunSearchResult } | null>(null)
  useEffect(() => {
    if (!query.trim()) return
    let alive = true
    let revision = 0
    const refresh = (): void => {
      const request = ++revision
      bridge.searchRuns(profileId, query.trim()).then((result) => {
        if (alive && request === revision) { setSearch({ query, result }); setError(null) }
      }, (cause: unknown) => { if (alive && request === revision) setError(errorText(cause)) })
    }
    const timer = setTimeout(refresh, 250)
    const off = followHostChanges(bridge, refresh)
    return () => { alive = false; clearTimeout(timer); off() }
  }, [bridge, profileId, query])
  const visibleRows = rows?.filter((row) =>
    (statusFilter === 'all' || (statusFilter === 'running' ? live.has(row.workspaceId) : !live.has(row.workspaceId))) &&
    (!since || (row.startedAt !== undefined && row.startedAt >= new Date(since).getTime()))
  )
  const visibleHits = search?.result.hits.filter((hit) =>
    (!since || (hit.startedAt !== undefined && hit.startedAt >= new Date(since).getTime())) &&
    (statusFilter === 'all' || (statusFilter === 'running' ? live.has(hit.workspaceId) : !live.has(hit.workspaceId)))
  ) ?? []

  useEffect(() => {
    let alive = true
    let revision = 0
    const refresh = (): void => {
      const request = ++revision
      bridge.listRuns(profileId).then(
      (next) => {
        if (alive && request === revision) { setRows(next); setError(null) }
      },
      (cause) => {
        if (alive && request === revision) setError(errorText(cause))
      }
      )
    }
    refresh()
    const off = followHostChanges(bridge, refresh)
    return () => {
      off()
      alive = false
    }
  }, [bridge, profileId])

  return (
    <div className="panel-archive">
      <input className="panel-answer-input" value={query} maxLength={2000} onChange={(event) => setQuery(event.target.value)} placeholder={t('panel.archiveSearch')} aria-label={t('panel.archiveSearch')} />
      <div className="panel-archive-filters">
        <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} aria-label={t('panel.archiveFilter')}>
          <option value="all">{t('panel.archiveAll')}</option><option value="running">{t('panel.archiveRunning')}</option><option value="stopped">{t('panel.archiveStopped')}</option>
        </select>
        <input type="date" value={since} onChange={(event) => setSince(event.target.value)} aria-label={t('panel.archiveSince')} />
      </div>
      {query.trim() ? (search?.query === query ? <div className="panel-archive-search">
        <p className="panel-retro-note">{t('panel.archiveSearched', { count: search.result.searchedRuns })}</p>
        {search.result.skipped.length ? <p className="panel-retro-note">{t('panel.archiveSkipped', { count: search.result.skipped.length })}</p> : null}
        {visibleHits.length === 0 ? <p className="panel-retro-note">{t('panel.archiveNoMatches')}</p> : null}
        {visibleHits.map((hit) => <section key={hit.workspaceId}>
          <button type="button" className="panel-archive-row" onClick={() => setOpenId((current) => current === hit.workspaceId ? null : hit.workspaceId)}>{hit.goal || hit.workspaceName || hit.workspaceId}</button>
          {hit.matches.map((match) => <p key={match.seq} className="panel-retro-note">{match.excerpt}</p>)}
          {openId === hit.workspaceId ? <><RunTimeline profileId={profileId} workspaceId={hit.workspaceId} live={live.has(hit.workspaceId)} bridge={bridge} /><RunReviewPanel profileId={profileId} workspaceId={hit.workspaceId} live={live.has(hit.workspaceId)} bridge={bridge} /></> : null}
        </section>)}
      </div> : !error ? <p className="panel-retro-note">{t('common.loading')}</p> : null) : null}
      {rows === null && !error ? <p className="panel-retro-note">{t('panel.archiveLoading')}</p> : null}
      {rows && rows.length === 0 ? <p className="panel-retro-note">{t('panel.archiveEmpty')}</p> : null}
      {!query.trim() && rows && rows.length > 0 && visibleRows?.length === 0 ? <p className="panel-retro-note">{t('panel.archiveNoMatches')}</p> : null}
      {!query.trim() && visibleRows && visibleRows.length > 0 ? (
        <ul className="panel-archive-list">
          {visibleRows.map((row) => {
            const isLive = live.has(row.workspaceId)
            const when = row.startedAt
              ? new Date(row.startedAt).toLocaleString(i18n.language)
              : ''
            const duration = archiveDurationLabel(t, row.durationMs)
            const title = [archiveGoalLine(row), when, duration].filter(Boolean).join(' · ')
            return (
              <li key={row.workspaceId} className="panel-archive-item">
                <button
                  type="button"
                  className={openId === row.workspaceId ? 'panel-archive-row is-open' : 'panel-archive-row'}
                  title={title}
                  aria-expanded={openId === row.workspaceId}
                  onClick={() =>
                    setOpenId((current) => (current === row.workspaceId ? null : row.workspaceId))
                  }
                >
                  <span className="panel-archive-goal">{archiveGoalLine(row)}</span>
                  <span className="panel-archive-pill">{archiveStatusLabel(t, row, isLive)}</span>
                  {row.pullRequestUrl ? (
                    <span className="panel-archive-pr">{t('panel.archivePr')}</span>
                  ) : null}
                  {duration ? <span className="panel-archive-meta">{duration}</span> : null}
                  {when ? <span className="panel-archive-meta">{when}</span> : null}
                </button>
                {row.skipped === 'too_large' && openId === row.workspaceId ? (
                  <p className="panel-retro-note">{t('panel.timelineTooLarge')}</p>
                ) : null}
                {openId === row.workspaceId && row.skipped !== 'too_large' ? (
                  <>
                  <RunTimeline
                    profileId={profileId}
                    workspaceId={row.workspaceId}
                    live={isLive}
                    bridge={bridge}
                  />
                  <RunReviewPanel profileId={profileId} workspaceId={row.workspaceId} live={isLive} bridge={bridge} />
                  </>
                ) : null}
              </li>
            )
          })}
        </ul>
      ) : null}
      {error ? <p className="panel-retro-error">{error}</p> : null}
    </div>
  )
}
