import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SessionRestoreStatus } from '@shared/sessions'

/**
 * Startup banner for restart recovery: shows whether the last run ended
 * unexpectedly, offers to restart restored session teams from their saved
 * states, and surfaces orphaned worktrees / stale sessions for explicit
 * cleanup. Every action is opt-in; dismissing the banner changes nothing.
 */
export default function SessionRestoreBanner(): JSX.Element | null {
  const { t } = useTranslation()
  const [status, setStatus] = useState<SessionRestoreStatus | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = (): void => {
    void window.vertragus.sessions
      .restoreStatus()
      .then(setStatus)
      .catch(() => setStatus(null))
  }

  useEffect(refresh, [])

  if (dismissed || !status) return null
  const hasContent =
    !status.cleanShutdown ||
    status.resumableSessions.length > 0 ||
    status.orphanedWorktrees.length > 0 ||
    status.staleSessions.length > 0
  if (!hasContent) return null

  const run = async (key: string, action: () => Promise<unknown>): Promise<void> => {
    setBusy(key)
    setError(null)
    try {
      await action()
      refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="restore-banner" role="region" aria-label={t('restore.title')}>
      <div className="restore-head">
        <span className="head">
          {status.cleanShutdown ? t('restore.title') : t('restore.titleCrash')}
        </span>
        <span className="rest">
          {status.restoredSessions > 0
            ? t('restore.summary', { count: status.restoredSessions })
            : t('restore.summaryNone')}
        </span>
        <button type="button" className="btn ghost restore-dismiss" onClick={() => setDismissed(true)}>
          {t('restore.dismiss')}
        </button>
      </div>
      {error && <div className="restore-error">{error}</div>}
      {status.resumableSessions.length > 0 && (
        <div className="restore-row">
          <span className="restore-label">{t('restore.resumable')}</span>
          {status.resumableSessions.map((session) => (
            <span key={session.id} className="restore-item">
              {session.name}
              <button
                type="button"
                className="btn ghost"
                disabled={busy != null}
                onClick={() =>
                  void run(`restart-${session.id}`, () =>
                    window.vertragus.sessions.restartAgents(session.profileId, session.id)
                  )
                }
              >
                {busy === `restart-${session.id}`
                  ? t('restore.restarting')
                  : t('restore.restart', { count: session.agentCount })}
              </button>
            </span>
          ))}
        </div>
      )}
      {status.orphanedWorktrees.length > 0 && (
        <div className="restore-row">
          <span className="restore-label">
            {t('restore.orphans', { count: status.orphanedWorktrees.length })}
          </span>
          {status.orphanedWorktrees.map((worktree) => (
            <span key={worktree.path} className="restore-item" title={worktree.path}>
              {worktree.sessionId}/{worktree.agentId}
              {worktree.changedFiles != null && worktree.changedFiles > 0 && (
                <em> · {t('restore.changedFiles', { count: worktree.changedFiles })}</em>
              )}
              <button
                type="button"
                className="btn ghost"
                disabled={busy != null}
                onClick={() => {
                  if (!window.confirm(t('restore.discardConfirm', { path: worktree.path }))) return
                  void run(`orphan-${worktree.path}`, () =>
                    window.vertragus.sessions.discardOrphanWorktree(worktree.path)
                  )
                }}
              >
                {t('restore.discard')}
              </button>
            </span>
          ))}
        </div>
      )}
      {status.staleSessions.length > 0 && (
        <div className="restore-row">
          <span className="restore-label">
            {t('restore.stale', { count: status.staleSessions.length })}
          </span>
          {status.staleSessions.map((session) => (
            <span key={session.id} className="restore-item">
              {session.name || session.id.slice(0, 8)}
              <em> · {new Date(session.updatedAt).toLocaleDateString()}</em>
              <button
                type="button"
                className="btn ghost"
                disabled={busy != null}
                onClick={() => {
                  if (!window.confirm(t('restore.staleConfirm'))) return
                  void run(`stale-${session.id}`, () =>
                    window.vertragus.workspaceSessions.remove(session.profileId, session.id)
                  )
                }}
              >
                {t('restore.discard')}
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
