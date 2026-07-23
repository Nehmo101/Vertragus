import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { OrphanedWorktreeInfo, SessionRestoreStatus } from '@shared/sessions'

type OrphanGroup = {
  sessionId: string
  items: OrphanedWorktreeInfo[]
  dirtyCount: number
}

function groupOrphans(orphans: OrphanedWorktreeInfo[]): OrphanGroup[] {
  const bySession = new Map<string, OrphanedWorktreeInfo[]>()
  for (const orphan of orphans) {
    const list = bySession.get(orphan.sessionId) ?? []
    list.push(orphan)
    bySession.set(orphan.sessionId, list)
  }
  return [...bySession.entries()]
    .map(([sessionId, items]) => ({
      sessionId,
      items,
      dirtyCount: items.filter((item) => item.changedFiles != null && item.changedFiles > 0).length
    }))
    .sort((a, b) => b.items.length - a.items.length || a.sessionId.localeCompare(b.sessionId))
}

/**
 * Startup recovery panel: structured restart / cleanup after a clean restore
 * or unexpected exit. Orphans stay collapsed by default so large leftovers
 * never drown the primary "restart team" actions.
 *
 * Dismiss ("continue") is kept for the renderer lifetime via a module flag so a
 * remount / Strict-Mode cycle cannot bring the banner back until the next app start.
 */
let dismissedForLaunch = false

export default function SessionRestoreBanner(): JSX.Element | null {
  const { t } = useTranslation()
  const [status, setStatus] = useState<SessionRestoreStatus | null>(null)
  const [dismissed, setDismissed] = useState(dismissedForLaunch)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Key of the destructive action currently armed for its second (confirming) click.
  const [confirming, setConfirming] = useState<string | null>(null)
  const [orphansOpen, setOrphansOpen] = useState(false)
  const [staleOpen, setStaleOpen] = useState(false)
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(() => new Set())

  const refresh = (): Promise<void> =>
    window.vertragus.sessions
      .restoreStatus()
      .then(setStatus)
      .catch(() => setStatus(null))

  useEffect(() => {
    // Load once on mount via the promise callback (not a sync setState-in-effect).
    void window.vertragus.sessions
      .restoreStatus()
      .then(setStatus)
      .catch(() => setStatus(null))
  }, [])

  const orphanGroups = useMemo(
    () => (status ? groupOrphans(status.orphanedWorktrees) : []),
    [status]
  )
  const dirtyOrphans = useMemo(
    () => status?.orphanedWorktrees.filter((item) => (item.changedFiles ?? 0) > 0) ?? [],
    [status]
  )
  // Only treat explicitly clean trees as bulk-safe; unknown git status stays out.
  const cleanOrphans = useMemo(
    () => status?.orphanedWorktrees.filter((item) => item.changedFiles === 0) ?? [],
    [status]
  )

  if (dismissed || !status) return null
  const hasContent =
    !status.cleanShutdown ||
    status.resumableSessions.length > 0 ||
    status.orphanedWorktrees.length > 0 ||
    status.staleSessions.length > 0
  // Keep the banner mounted while a discard/restart is in flight — optimistic
  // orphan removal can clear hasContent before the main process finishes.
  if (!hasContent && busy == null) return null

  const run = async (key: string, action: () => Promise<unknown>): Promise<void> => {
    setBusy(key)
    setError(null)
    setConfirming(null)
    try {
      await action()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      // Wait for the re-scan before unlocking actions — otherwise a second
      // "Verwerfen" starts while inventory is still walking the old leftovers.
      try {
        await refresh()
      } finally {
        setBusy(null)
      }
    }
  }

  const discardPaths = (key: string, paths: string[]): void => {
    if (paths.length === 0) return
    // Optimistically clear the targets so the banner shrinks immediately while
    // the main process finishes filesystem + git cleanup.
    setStatus((prev) =>
      prev
        ? {
            ...prev,
            orphanedWorktrees: prev.orphanedWorktrees.filter((item) => !paths.includes(item.path))
          }
        : prev
    )
    void run(key, async () => {
      const result = await window.vertragus.sessions.discardOrphanWorktrees(paths)
      if (result.failed > 0) {
        throw new Error(
          t('restore.discardResult', {
            discarded: result.discarded,
            failed: result.failed
          })
        )
      }
    })
  }

  const toggleSession = (sessionId: string): void => {
    setExpandedSessions((prev) => {
      const next = new Set(prev)
      if (next.has(sessionId)) next.delete(sessionId)
      else next.add(sessionId)
      return next
    })
  }

  const restartAll = async (): Promise<void> => {
    setBusy('restart-all')
    setError(null)
    setConfirming(null)
    try {
      for (const session of status.resumableSessions) {
        await window.vertragus.sessions.restartAgents(session.profileId, session.id)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      try {
        await refresh()
      } finally {
        setBusy(null)
      }
    }
  }

  /** First click arms the confirm; a second click on the same key runs the action. */
  const requestOrConfirm = (key: string, action: () => void): void => {
    if (confirming !== key) {
      setConfirming(key)
      return
    }
    setConfirming(null)
    action()
  }

  /**
   * Destructive action rendered with an in-banner two-click confirm — never
   * window.confirm, which is unreliable / blocked in many Electron renderers.
   * First click arms: the label flips to a short confirm prompt, the full
   * warning moves to the title tooltip, and a cancel button appears. A second
   * click on the same button runs the action.
   */
  const renderConfirmAction = (
    key: string,
    idleLabel: string,
    confirmTitle: string,
    action: () => void
  ): JSX.Element => {
    const armed = confirming === key
    return (
      <span className="restore-confirm">
        <button
          type="button"
          className={armed ? 'btn ghost armed' : 'btn ghost'}
          disabled={busy != null}
          title={armed ? confirmTitle : undefined}
          aria-label={armed ? confirmTitle : undefined}
          onClick={() => requestOrConfirm(key, action)}
        >
          {busy === key ? t('restore.discarding') : armed ? t('restore.confirm') : idleLabel}
        </button>
        {armed && (
          <button
            type="button"
            className="btn ghost"
            disabled={busy != null}
            onClick={() => setConfirming(null)}
          >
            {t('restore.cancel')}
          </button>
        )}
      </span>
    )
  }

  return (
    <div className="restore-banner" role="region" aria-label={t('restore.title')}>
      <div className="restore-head">
        <div className="restore-head-copy">
          <span className="head">
            {status.cleanShutdown ? t('restore.title') : t('restore.titleCrash')}
          </span>
          <span className="rest">
            {busy != null && (busy === 'orphans-all' || busy === 'orphans-clean' || busy.startsWith('orphan-'))
              ? t('restore.discarding')
              : status.restoredSessions > 0
                ? t('restore.summary', { count: status.restoredSessions })
                : t('restore.summaryNone')}
          </span>
        </div>
        <div className="restore-head-actions">
          {status.resumableSessions.length > 1 && (
            <button
              type="button"
              className="btn primary"
              disabled={busy != null}
              onClick={() => void restartAll()}
            >
              {busy === 'restart-all' ? t('restore.restarting') : t('restore.restartAll')}
            </button>
          )}
          {status.resumableSessions.length === 1 && (
            <button
              type="button"
              className="btn primary"
              disabled={busy != null}
              onClick={() => {
                const session = status.resumableSessions[0]!
                void run(`restart-${session.id}`, () =>
                  window.vertragus.sessions.restartAgents(session.profileId, session.id)
                )
              }}
            >
              {busy === `restart-${status.resumableSessions[0]!.id}`
                ? t('restore.restarting')
                : t('restore.restart', { count: status.resumableSessions[0]!.agentCount })}
            </button>
          )}
          <button
            type="button"
            className={status.resumableSessions.length > 0 ? 'btn ghost' : 'btn primary'}
            disabled={busy != null}
            onClick={() => {
              dismissedForLaunch = true
              setDismissed(true)
            }}
          >
            {status.resumableSessions.length > 0 ? t('restore.continue') : t('restore.continueClean')}
          </button>
        </div>
      </div>

      {error && <div className="restore-error">{error}</div>}

      {status.resumableSessions.length > 0 && (
        <section className="restore-section">
          <div className="restore-section-head">
            <span className="restore-label">{t('restore.resumable')}</span>
            <span className="restore-meta">
              {t('restore.resumableMeta', { count: status.resumableSessions.length })}
            </span>
          </div>
          <ul className="restore-list">
            {status.resumableSessions.map((session) => (
              <li key={session.id} className="restore-card">
                <div className="restore-card-main">
                  <strong>{session.name || session.id.slice(0, 8)}</strong>
                  <span className="restore-meta">
                    {t('restore.agentMeta', { count: session.agentCount })}
                    {' · '}
                    {t('restore.capturedAt', {
                      date: new Date(session.capturedAt).toLocaleString()
                    })}
                  </span>
                </div>
                <button
                  type="button"
                  className="btn primary"
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
              </li>
            ))}
          </ul>
        </section>
      )}

      {status.orphanedWorktrees.length > 0 && (
        <section className="restore-section">
          <div className="restore-section-head">
            <button
              type="button"
              className="restore-toggle"
              aria-expanded={orphansOpen}
              onClick={() => setOrphansOpen((open) => !open)}
            >
              <span className="restore-label">
                {t('restore.orphans', { count: status.orphanedWorktrees.length })}
              </span>
              <span className="restore-meta">
                {t('restore.orphansMeta', {
                  groups: orphanGroups.length,
                  dirty: dirtyOrphans.length,
                  clean: cleanOrphans.length
                })}
              </span>
              <span className="restore-chevron" aria-hidden>
                {orphansOpen ? '▾' : '▸'}
              </span>
            </button>
            <div className="restore-section-actions">
              {cleanOrphans.length > 0 &&
                renderConfirmAction(
                  'orphans-clean',
                  t('restore.discardClean', { count: cleanOrphans.length }),
                  t('restore.discardCleanConfirm', { count: cleanOrphans.length }),
                  () => discardPaths('orphans-clean', cleanOrphans.map((item) => item.path))
                )}
              {renderConfirmAction(
                'orphans-all',
                t('restore.discardAll', { count: status.orphanedWorktrees.length }),
                t('restore.discardAllConfirm', {
                  count: status.orphanedWorktrees.length,
                  path: status.orphanedWorktrees[0]?.path ?? ''
                }),
                () =>
                  discardPaths(
                    'orphans-all',
                    status.orphanedWorktrees.map((item) => item.path)
                  )
              )}
            </div>
          </div>
          {orphansOpen && (
            <ul className="restore-list restore-list-scroll">
              {orphanGroups.map((group) => {
                const open = expandedSessions.has(group.sessionId) || orphanGroups.length === 1
                return (
                  <li key={group.sessionId} className="restore-group">
                    <button
                      type="button"
                      className="restore-group-head"
                      aria-expanded={open}
                      onClick={() => toggleSession(group.sessionId)}
                    >
                      <strong>{group.sessionId}</strong>
                      <span className="restore-meta">
                        {t('restore.orphanGroupMeta', {
                          count: group.items.length,
                          dirty: group.dirtyCount
                        })}
                      </span>
                      <span className="restore-chevron" aria-hidden>
                        {open ? '▾' : '▸'}
                      </span>
                    </button>
                    {open && (
                      <ul className="restore-sublist">
                        {group.items.map((worktree) => (
                          <li key={worktree.path} className="restore-card restore-card-compact" title={worktree.path}>
                            <div className="restore-card-main">
                              <code>{worktree.agentId}</code>
                              {worktree.changedFiles != null && worktree.changedFiles > 0 ? (
                                <em>{t('restore.changedFiles', { count: worktree.changedFiles })}</em>
                              ) : (
                                <em>{t('restore.cleanWorktree')}</em>
                              )}
                            </div>
                            {renderConfirmAction(
                              `orphan-${worktree.path}`,
                              t('restore.discard'),
                              t('restore.discardConfirm', { count: 1, path: worktree.path }),
                              () =>
                                void run(`orphan-${worktree.path}`, async () => {
                                  const ok = await window.vertragus.sessions.discardOrphanWorktree(
                                    worktree.path
                                  )
                                  if (!ok) {
                                    throw new Error(
                                      t('restore.discardResult', { discarded: 0, failed: 1 })
                                    )
                                  }
                                })
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      )}

      {status.staleSessions.length > 0 && (
        <section className="restore-section">
          <div className="restore-section-head">
            <button
              type="button"
              className="restore-toggle"
              aria-expanded={staleOpen}
              onClick={() => setStaleOpen((open) => !open)}
            >
              <span className="restore-label">
                {t('restore.stale', { count: status.staleSessions.length })}
              </span>
              <span className="restore-chevron" aria-hidden>
                {staleOpen ? '▾' : '▸'}
              </span>
            </button>
          </div>
          {staleOpen && (
            <ul className="restore-list restore-list-scroll">
              {status.staleSessions.map((session) => (
                <li key={session.id} className="restore-card restore-card-compact">
                  <div className="restore-card-main">
                    <strong>{session.name || session.id.slice(0, 8)}</strong>
                    <em>{new Date(session.updatedAt).toLocaleDateString()}</em>
                  </div>
                  {renderConfirmAction(
                    `stale-${session.id}`,
                    t('restore.discard'),
                    t('restore.staleConfirm'),
                    () =>
                      void run(`stale-${session.id}`, () =>
                        window.vertragus.workspaceSessions.remove(session.profileId, session.id)
                      )
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  )
}
