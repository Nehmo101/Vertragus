import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { RunListEntry, VertragusAppApi } from '../../../preload'
import { errorText } from './viewModel'
import { archiveDurationLabel, archiveGoalLine, archiveStatusLabel } from './archiveViewModel'
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

  useEffect(() => {
    let alive = true
    bridge.listRuns(profileId).then(
      (next) => {
        if (alive) setRows(next)
      },
      (cause) => {
        if (alive) setError(errorText(cause))
      }
    )
    return () => {
      alive = false
    }
  }, [bridge, profileId])

  return (
    <div className="panel-archive">
      {rows === null && !error ? <p className="panel-retro-note">{t('panel.archiveLoading')}</p> : null}
      {rows && rows.length === 0 ? <p className="panel-retro-note">{t('panel.archiveEmpty')}</p> : null}
      {rows && rows.length > 0 ? (
        <ul className="panel-archive-list">
          {rows.map((row) => {
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
                  <RunTimeline
                    profileId={profileId}
                    workspaceId={row.workspaceId}
                    live={isLive}
                    bridge={bridge}
                  />
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
