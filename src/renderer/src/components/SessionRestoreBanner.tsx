import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SessionRestoreStatus } from '@shared/sessions'

/**
 * Startup banner for restart recovery: shows whether the last run ended
 * unexpectedly, offers to restart restored session teams from their saved
 * states, and surfaces orphaned worktrees / stale sessions for explicit
 * cleanup. Every action is opt-in; dismissing the banner changes nothing.
 *
 * Dismiss is kept for the renderer lifetime (module flag) so a remount /
 * Strict-Mode cycle cannot bring the banner back until the next app start.
 * Destructive actions use an in-banner two-click confirm — never window.confirm,
 * which is unreliable / blocked in many Electron renderer setups.
 */
let dismissedForLaunch = false

export default function SessionRestoreBanner(): JSX.Element | null {
  const { t } = useTranslation()
  const [status, setStatus] = useState<SessionRestoreStatus | null>(null)
  const [dismissed, setDismissed] = useState(dismissedForLaunch)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)

  const refresh = (): void => {
    void window.vertragus.sessions
      .restoreStatus()
      .then(setStatus)
      .catch(() => setStatus(null))
  }

  useEffect(refresh, [])

  const dismiss = (): void => {
    dismissedForLaunch = true
    setConfirming(null)
    setDismissed(true)
  }

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
    setConfirming(null)
    try {
      await action()
      refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  /** First click arms confirm; second click on the same key runs the action. */
  const requestOrConfirm = (key: string, action: () => Promise<unknown>): void => {
    if (confirming !== key) {
      setConfirming(key)
      return
    }
    void run(key, action)
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
        <button
          type="button"
          className="btn ghost restore-dismiss"
          onClick={dismiss}
          aria-label={t('restore.dismiss')}
        >
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
          {status.orphanedWorktrees.map((worktree) => {
            const key = `orphan-${worktree.path}`
            const armed = confirming === key
            return (
              <span key={worktree.path} className="restore-item" title={worktree.path}>
                {worktree.sessionId}/{worktree.agentId}
                {worktree.changedFiles != null && worktree.changedFiles > 0 && (
                  <em> · {t('restore.changedFiles', { count: worktree.changedFiles })}</em>
                )}
                <button
                  type="button"
                  className="btn ghost"
                  disabled={busy != null}
                  title={armed ? worktree.path : undefined}
                  onClick={() =>
                    requestOrConfirm(key, () =>
                      window.vertragus.sessions.discardOrphanWorktree(worktree.path)
                    )
                  }
                >
                  {armed
                    ? t('restore.discardConfirm', { path: worktree.path })
                    : t('restore.discard')}
                </button>
                {armed && (
                  <button
                    type="button"
                    className="btn ghost"
                    disabled={busy != null}
                    onClick={() => setConfirming(null)}
                  >
                    {t('restore.dismiss')}
                  </button>
                )}
              </span>
            )
          })}
        </div>
      )}
      {status.staleSessions.length > 0 && (
        <div className="restore-row">
          <span className="restore-label">
            {t('restore.stale', { count: status.staleSessions.length })}
          </span>
          {status.staleSessions.map((session) => {
            const key = `stale-${session.id}`
            const armed = confirming === key
            return (
              <span key={session.id} className="restore-item">
                {session.name || session.id.slice(0, 8)}
                <em> · {new Date(session.updatedAt).toLocaleDateString()}</em>
                <button
                  type="button"
                  className="btn ghost"
                  disabled={busy != null}
                  onClick={() =>
                    requestOrConfirm(key, () =>
                      window.vertragus.workspaceSessions.remove(session.profileId, session.id)
                    )
                  }
                >
                  {armed ? t('restore.staleConfirm') : t('restore.discard')}
                </button>
                {armed && (
                  <button
                    type="button"
                    className="btn ghost"
                    disabled={busy != null}
                    onClick={() => setConfirming(null)}
                  >
                    {t('restore.dismiss')}
                  </button>
                )}
              </span>
            )
          })}
        </div>
      )}
      <div className="restore-row">
        <button type="button" className="btn ghost restore-dismiss" onClick={dismiss}>
          {t('restore.dismiss')}
        </button>
      </div>
    </div>
  )
}
