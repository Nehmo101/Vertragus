import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { StaleWorktreeSummary, VertragusAppApi } from '../../../preload'
import { errorText } from './viewModel'
import { TrashIcon } from './icons'

interface Props {
  profileId: string
  bridge: VertragusAppApi
}

/** The tail of a worktree path when the branch name is gone (detached HEAD). */
function worktreeLabel(entry: StaleWorktreeSummary): string {
  return entry.branch ?? (entry.path.split(/[\\/]/).pop() || entry.path)
}

/**
 * The cleanup list under a profile row: every worktree agents left behind in
 * this profile's repository, each with its own remove button.
 *
 * Errors stay INSIDE this box (a dirty worktree that git refuses to remove is
 * a per-entry condition, not an app failure), and nothing here is destructive
 * beyond what main allows: live agents' worktrees never appear, git refuses
 * uncommitted changes, and branches survive every removal.
 */
export function WorktreeCleanup({ profileId, bridge }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const [entries, setEntries] = useState<StaleWorktreeSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busyPath, setBusyPath] = useState<string | null>(null)

  // No synchronous state reset here: the caller keys this component by
  // profileId, so a different profile is a fresh mount with fresh state.
  useEffect(() => {
    let alive = true
    bridge.listStaleWorktrees(profileId).then(
      (next) => {
        if (alive) setEntries(next)
      },
      (cause) => {
        if (alive) setError(errorText(cause))
      }
    )
    return () => {
      alive = false
    }
  }, [bridge, profileId])

  const remove = (path: string): void => {
    setBusyPath(path)
    setError(null)
    bridge.removeWorktree(profileId, path).then(
      (next) => {
        setBusyPath(null)
        setEntries(next)
      },
      (cause) => {
        setBusyPath(null)
        setError(errorText(cause))
      }
    )
  }

  return (
    <div className="panel-worktrees">
      {entries === null && !error ? (
        <p className="panel-worktrees-note">{t('panel.worktreesLoading')}</p>
      ) : null}
      {entries !== null && entries.length === 0 ? (
        <p className="panel-worktrees-note">{t('panel.worktreesEmpty')}</p>
      ) : null}
      {entries && entries.length > 0 ? (
        <ul className="panel-worktrees-list">
          {entries.map((entry) => (
            <li key={entry.path} className="panel-worktrees-row" title={entry.path}>
              <span className="panel-worktrees-branch">{worktreeLabel(entry)}</span>
              <button
                type="button"
                className="panel-icon-button panel-worktrees-remove"
                title={t('panel.removeWorktree', { branch: worktreeLabel(entry) })}
                aria-label={t('panel.removeWorktree', { branch: worktreeLabel(entry) })}
                disabled={busyPath !== null}
                onClick={() => remove(entry.path)}
              >
                <TrashIcon />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <p className="panel-worktrees-error">{error}</p> : null}
    </div>
  )
}
